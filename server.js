import express from 'express'
import multer from 'multer'
import WebTorrent from 'webtorrent'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'))
const PORT = process.env.PORT || 3456

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

// Extra public trackers improve peer discovery for poorly-seeded torrents.
// DHT + PEX are on by default, which is what finds stray peers on dead torrents.
const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'http://tracker.opentrackr.org:1337/announce'
]

// TORRENT_PORT gives Docker users a fixed port to map for incoming peers.
const client = new WebTorrent({
  maxConns: 150,
  torrentPort: Number(process.env.TORRENT_PORT) || undefined
})
client.on('error', (err) => console.error('[client]', err.message))

// webtorrent has occasional internal races (e.g. piece-selection on resume).
// A personal downloader should log and keep serving, not die mid-10GB-download.
process.on('uncaughtException', (err) => console.error('[uncaught]', err.stack))
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
// Self-hosted fonts and icons — the UI works fully offline.
app.use('/assets/outfit', express.static(path.join(__dirname, 'node_modules/@fontsource-variable/outfit')))
app.use('/assets/jetbrains-mono', express.static(path.join(__dirname, 'node_modules/@fontsource-variable/jetbrains-mono')))
app.use('/assets/phosphor', express.static(path.join(__dirname, 'node_modules/@phosphor-icons/web/src')))

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// webtorrent getters can throw during internal state transitions
// (pre-metadata, piece verification races) — degrade to a fallback
// instead of 500ing the status poll.
function safe(fn, fallback = 0) {
  try {
    const v = fn()
    return v === undefined || Number.isNaN(v) ? fallback : v
  } catch {
    return fallback
  }
}

// Progress, percentage, and ETA are computed here from verified byte counts
// rather than trusted from webtorrent's derived getters, and clamped so a
// transient library inconsistency can never surface as >100% or negative.
function torrentInfo(t) {
  const done = !!t.done
  const length = Math.max(0, safe(() => t.length))
  let downloaded = Math.max(0, safe(() => t.downloaded))
  if (length) downloaded = Math.min(downloaded, length)
  if (done && length) downloaded = length
  const progress = done ? 1 : length ? downloaded / length : 0
  const downloadSpeed = Math.max(0, safe(() => t.downloadSpeed))
  const uploadSpeed = Math.max(0, safe(() => t.uploadSpeed))
  // ETA from remaining bytes over current (smoothed) speed; null = unknown.
  const timeRemaining = done ? 0
    : (length && downloadSpeed > 0) ? ((length - downloaded) / downloadSpeed) * 1000
    : null

  return {
    infoHash: t.infoHash,
    name: t.name || null,
    magnetURI: safe(() => t.magnetURI, null),
    progress,
    downloaded,
    uploaded: Math.max(0, safe(() => t.uploaded)),
    length,
    downloadSpeed,
    uploadSpeed,
    numPeers: safe(() => t.numPeers),
    timeRemaining,
    done,
    paused: t.paused,
    ready: t.ready,
    files: t.files.map((f, i) => {
      const fDone = done || !!f.done
      const fProgress = fDone ? 1 : Math.min(1, Math.max(0, safe(() => f.progress)))
      return {
        index: i,
        name: f.name,
        path: f.path,
        absPath: path.join(DOWNLOAD_DIR, f.path),
        length: f.length,
        progress: fProgress,
        done: fDone
      }
    })
  }
}

function findTorrent(infoHash) {
  return client.torrents.find((t) => t.infoHash === infoHash.toLowerCase())
}

function attachTorrentHandlers(t) {
  t.on('error', (err) => console.error(`[torrent ${t.infoHash}]`, err.message))
  t.on('done', () => console.log(`[done] ${t.name}`))
}

async function addSource(source, res) {
  const existing = await client.get(source)
  if (existing) {
    return res.status(409).json({ error: 'Torrent already added', torrent: torrentInfo(existing) })
  }
  const t = client.add(source, { path: DOWNLOAD_DIR, announce: EXTRA_TRACKERS })
  attachTorrentHandlers(t)
  // For magnets the infoHash is parsed synchronously; metadata (name/files)
  // arrives later, or never if no peer is reachable — respond immediately.
  res.status(202).json(torrentInfo(t))
}

app.get('/api/torrents', (_req, res) => {
  res.json(client.torrents.map(torrentInfo))
})

app.post('/api/torrents', async (req, res) => {
  const { magnet } = req.body || {}
  if (!magnet || !/^magnet:\?/i.test(magnet.trim())) {
    return res.status(400).json({ error: 'Provide a magnet link in the "magnet" field' })
  }
  try {
    await addSource(magnet.trim(), res)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/torrents/file', upload.single('torrent'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a .torrent file in the "torrent" field' })
  try {
    await addSource(req.file.buffer, res)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/torrents/:infoHash/pause', (req, res) => {
  const t = findTorrent(req.params.infoHash)
  if (!t) return res.status(404).json({ error: 'Not found' })
  t.pause()
  res.json(torrentInfo(t))
})

app.post('/api/torrents/:infoHash/resume', (req, res) => {
  const t = findTorrent(req.params.infoHash)
  if (!t) return res.status(404).json({ error: 'Not found' })
  t.resume()
  res.json(torrentInfo(t))
})

app.delete('/api/torrents/:infoHash', (req, res) => {
  const t = findTorrent(req.params.infoHash)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const destroyStore = req.query.deleteFiles === 'true'
  client.remove(t.infoHash, { destroyStore }, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ removed: true, filesDeleted: destroyStore })
  })
})

// Serve a finished file to the browser. Files are already on disk in
// DOWNLOAD_DIR; res.download streams with Range support, so 10GB+ is fine.
app.get('/api/torrents/:infoHash/files/:index', (req, res) => {
  const t = findTorrent(req.params.infoHash)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const file = t.files[Number(req.params.index)]
  if (!file) return res.status(404).json({ error: 'File not found' })
  const complete = t.done || file.done || safe(() => file.progress) >= 1
  if (!complete) {
    const progress = Math.min(1, Math.max(0, safe(() => file.progress)))
    return res.status(409).json({ error: `File is ${(progress * 100).toFixed(1)}% complete — not downloadable yet` })
  }
  res.download(path.join(DOWNLOAD_DIR, file.path), file.name)
})

app.get('/api/status', (_req, res) => {
  res.json({
    downloadDir: DOWNLOAD_DIR,
    torrents: client.torrents.length,
    downloadSpeed: client.downloadSpeed,
    uploadSpeed: client.uploadSpeed
  })
})

const httpServer = app.listen(PORT, () => {
  console.log(`TorrentBox running at http://localhost:${PORT}`)
  console.log(`Saving downloads to ${DOWNLOAD_DIR}`)
})
// Failing to bind the port is fatal — never survive as a zombie process.
httpServer.on('error', (err) => {
  console.error(`[fatal] could not start server: ${err.message}`)
  process.exit(1)
})
