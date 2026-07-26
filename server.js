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
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://opentracker.io:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce'
]

// Fixed listen port (TORRENT_PORT) so it can be forwarded/mapped — being
// connectable to inbound peers is the biggest real-world speed factor.
const TORRENT_PORT = Number(process.env.TORRENT_PORT) || 42069

const client = new WebTorrent({
  maxConns: 200,             // peer connections per torrent (default 55)
  maxWebConns: 10,           // parallel web-seed connections (default 4)
  downloadLimit: -1,         // explicitly unthrottled
  uploadLimit: -1,
  utp: true,                 // uTP alongside TCP — reaches peers TCP can't
  dht: { concurrency: 64 },  // faster DHT lookups (default 16)
  natUpnp: 'permanent',      // auto port-map on the router (UPnP)
  natPmp: true,              // …and NAT-PMP — inbound peers = most speed
  torrentPort: TORRENT_PORT
})

// Graceful shutdown: destroys the client, which also removes router port
// mappings and announces our departure to trackers.
function shutdown() {
  const forceExit = setTimeout(() => process.exit(0), 3000)
  forceExit.unref()
  client.destroy(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
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

// All progress below is BYTE-weighted, computed directly from the piece
// bitfield — never from file counts and never from webtorrent's derived
// getters. A 5MB file at 100% moves a 150MB torrent by ~3%, not by
// "1 of 3 files".

// Bytes of piece `i` that are actually on disk: the full piece when verified
// (verified pieces are nulled in t.pieces), otherwise the received portion.
function pieceHave(t, i) {
  const pieceLength = t.pieceLength
  const pLen = i === t.pieces.length - 1 ? t.lastPieceLength : pieceLength
  const piece = t.pieces[i]
  if ((t.bitfield && t.bitfield.get(i)) || !piece) return pLen
  return Math.max(0, pLen - piece.missing)
}

// Total verified+received bytes for the whole torrent.
function torrentDownloaded(t) {
  if (!t.pieces || !t.pieces.length) return 0
  let bytes = 0
  for (let i = 0; i < t.pieces.length; i++) bytes += pieceHave(t, i)
  return bytes
}

// Bytes on disk that fall inside one file's byte range. Boundary pieces
// shared with neighbouring files contribute proportionally to the overlap.
function fileDownloaded(t, f) {
  if (!t.pieces || !t.pieces.length || !f.length) return 0
  const pieceLength = t.pieceLength
  const start = Math.floor(f.offset / pieceLength)
  const end = Math.floor((f.offset + f.length - 1) / pieceLength)
  let bytes = 0
  for (let i = start; i <= end && i < t.pieces.length; i++) {
    const pLen = i === t.pieces.length - 1 ? t.lastPieceLength : pieceLength
    const pieceStart = i * pieceLength
    const overlap = Math.min(f.offset + f.length, pieceStart + pLen) - Math.max(f.offset, pieceStart)
    if (overlap <= 0) continue
    bytes += pieceHave(t, i) * (overlap / pLen)
  }
  return Math.min(f.length, Math.round(bytes))
}

// Percentage and ETA are derived from the byte counts above and clamped so a
// transient library inconsistency can never surface as >100% or negative.
function torrentInfo(t) {
  const done = !!t.done
  const length = Math.max(0, safe(() => t.length))
  let downloaded = Math.max(0, safe(() => torrentDownloaded(t)))
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
      const fBytes = done ? f.length : Math.max(0, safe(() => fileDownloaded(t, f)))
      const fDone = done || !!f.done || fBytes >= f.length
      const fProgress = fDone ? 1 : f.length ? fBytes / f.length : 0
      return {
        index: i,
        name: f.name,
        path: f.path,
        absPath: path.join(DOWNLOAD_DIR, f.path),
        length: f.length,
        downloaded: fDone ? f.length : fBytes,
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
  const bytes = safe(() => fileDownloaded(t, file))
  const complete = t.done || file.done || bytes >= file.length
  if (!complete) {
    const progress = file.length ? Math.min(1, Math.max(0, bytes / file.length)) : 0
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
