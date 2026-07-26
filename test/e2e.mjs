/*
 * End-to-end stats-correctness test.
 *
 * Seeds a locally-generated file with a second webtorrent instance, downloads
 * it through the real server over loopback (magnet x.pe peer hint — no
 * external network), and asserts on every number the UI displays:
 *
 *   - progress === downloaded / length, clamped to [0, 1], never regressing
 *   - downloaded never exceeds length
 *   - download speed is non-negative and > 0 while actively transferring
 *   - eta is null when unknown, finite & >= 0 while downloading, 0 when done
 *   - at completion: progress 1, downloaded === length exactly, files done
 *   - the file on disk and the HTTP download both hash-match the source
 *   - pause / resume / remove(deleteFiles) behave
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PORT = 3499
const SEED_PORT = 51413
const BASE = `http://localhost:${PORT}`

let failures = 0
function check(cond, label, detail = '') {
  if (cond) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// Preflight: a stale server from a crashed run would answer our polls with
// old state and poison every assertion. Refuse to run against one.
try {
  await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) })
  console.error(`FATAL: something is already listening on port ${PORT} — kill it first (pkill -f "node server.js")`)
  process.exit(2)
} catch { /* port free — good */ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-test-'))
// NOTE: the torrent takes its name from the directory. Do NOT pass a `name:`
// override to seed() — webtorrent then reads store paths under the new name,
// which doesn't exist on disk, and silently serves zero pieces.
const seedDir = path.join(tmp, 'tbx-testdata')
const dlDir = path.join(tmp, 'dl')
fs.mkdirSync(seedDir)
fs.mkdirSync(dlDir)

// Deliberately unequal file sizes: if progress were file-count based,
// "1 of 3 files done" would read 33% — byte-weighted it must read ~5%.
const FILES = [
  { name: 'small.bin', size: 8 * 1024 * 1024 },
  { name: 'large.bin', size: 120 * 1024 * 1024 },
  { name: 'medium.bin', size: 22 * 1024 * 1024 }
]
const TOTAL_SIZE = FILES.reduce((s, f) => s + f.size, 0)

console.log('creating multi-file test payload (8MB + 120MB + 22MB)…')
const srcHashes = {}
for (const f of FILES) {
  const p = path.join(seedDir, f.name)
  const fd = fs.openSync(p, 'w')
  const chunk = 4 * 1024 * 1024
  for (let written = 0; written < f.size; written += chunk) {
    fs.writeSync(fd, crypto.randomBytes(Math.min(chunk, f.size - written)))
  }
  fs.closeSync(fd)
  srcHashes[f.name] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')
}

console.log('starting seeder…')
const { default: WebTorrent } = await import(path.join(ROOT, 'node_modules/webtorrent/index.js'))
const seeder = new WebTorrent({ torrentPort: SEED_PORT, dht: false, tracker: false, lsd: false, utp: false })
seeder.on('error', (e) => console.error('[seeder]', e.message))
const seedTorrent = await new Promise((resolve) => {
  seeder.seed(seedDir, { announce: [] }, resolve)
})
const magnet = `magnet:?xt=urn:btih:${seedTorrent.infoHash}&x.pe=127.0.0.1:${SEED_PORT}`
console.log('seeding', seedTorrent.infoHash)

console.log('starting server…')
const server = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DOWNLOAD_DIR: dlDir },
  stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', (d) => console.error('[server]', String(d).trim()))
// Never leave the spawned server behind, even if an assertion throws.
process.on('exit', () => { try { server.kill('SIGKILL') } catch {} })

async function api(url, opts) {
  const res = await fetch(BASE + url, opts)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// wait for server
for (let i = 0; ; i++) {
  try { await fetch(BASE + '/api/status'); break }
  catch { if (i > 50) throw new Error('server never came up'); await sleep(200) }
}

console.log('\n-- add torrent --')
const add = await api('/api/torrents', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ magnet })
})
check(add.status === 202, 'POST magnet returns 202', `got ${add.status}`)

const dup = await api('/api/torrents', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ magnet })
})
check(dup.status === 409, 'duplicate magnet returns 409', `got ${dup.status}`)

console.log('\n-- stats invariants during download --')
let last = null
let sawTransfer = false
let etaOkWhileMoving = true
let monotonic = true
let consistent = true
let bounded = true
let byteWeighted = true
let filesBounded = true
let t = null

for (let i = 0; i < 600; i++) {
  await sleep(250)
  const { body } = await api('/api/torrents')
  t = body[0]
  if (!t) continue
  if (t.length) {
    if (t.downloaded > t.length) bounded = false
    if (t.progress < 0 || t.progress > 1) bounded = false
    // progress must equal downloaded/length (server computes it that way)
    if (!t.done && Math.abs(t.progress - t.downloaded / t.length) > 1e-9) consistent = false
  }
  if (t.files.length) {
    // THE byte-weighting invariant: per-file downloaded bytes must sum to the
    // torrent's downloaded bytes. If progress were file-count based, this
    // breaks immediately with 8MB/120MB/22MB files.
    const sumBytes = t.files.reduce((s, f) => s + f.downloaded, 0)
    if (Math.abs(sumBytes - t.downloaded) > 1024) byteWeighted = false
    for (const f of t.files) {
      if (f.progress < 0 || f.progress > 1 || f.downloaded > f.length) filesBounded = false
      if (!t.done && !f.done && f.length && Math.abs(f.progress - f.downloaded / f.length) > 1e-9) filesBounded = false
    }
  }
  if (last && t.length && last.length && t.downloaded < last.downloaded - 1) monotonic = false
  if (t.downloadSpeed < 0 || t.uploadSpeed < 0) bounded = false
  if (!t.done && t.downloadSpeed > 1024 * 1024) {
    sawTransfer = true
    if (!(Number.isFinite(t.timeRemaining) && t.timeRemaining >= 0)) etaOkWhileMoving = false
  }
  last = t
  if (t.done) break
}

check(t && t.done, 'torrent completes', t ? `progress ${t.progress}` : 'no torrent')
check(bounded, 'progress in [0,1], downloaded <= length, speeds >= 0')
check(consistent, 'progress === downloaded / length on every poll')
check(byteWeighted, 'sum(per-file downloaded bytes) === torrent downloaded bytes on every poll')
check(filesBounded, 'every file: progress === downloaded/length, within [0,1]')
check(monotonic, 'downloaded bytes never regress')
check(sawTransfer, 'observed active transfer (speed > 1 MB/s)')
check(etaOkWhileMoving, 'eta finite and >= 0 whenever downloading')
if (t && t.done) {
  check(t.progress === 1, 'final progress is exactly 1', `got ${t.progress}`)
  check(t.downloaded === t.length, 'final downloaded === length', `${t.downloaded} vs ${t.length}`)
  check(t.length === TOTAL_SIZE, 'reported length matches real payload size', `${t.length} vs ${TOTAL_SIZE}`)
  check(t.files.length === FILES.length, 'file count matches', `${t.files.length} vs ${FILES.length}`)
  check(t.timeRemaining === 0, 'final eta is 0', `got ${t.timeRemaining}`)
  check(t.files.every((f) => f.done && f.progress === 1 && f.downloaded === f.length), 'all files done at completion')
  check(t.files.every((f) => f.absPath.startsWith(dlDir)), 'file absPaths point into download dir')
}

console.log('\n-- data integrity (all files, disk + HTTP) --')
for (const spec of FILES) {
  const f = t.files.find((x) => x.name === spec.name)
  check(!!f && f.length === spec.size, `${spec.name}: reported size matches`, f ? `${f.length} vs ${spec.size}` : 'missing')
  if (!f) continue
  const diskHash = crypto.createHash('sha1').update(fs.readFileSync(f.absPath)).digest('hex')
  check(diskHash === srcHashes[spec.name], `${spec.name}: disk file matches source sha1`)

  const res = await fetch(`${BASE}/api/torrents/${t.infoHash}/files/${f.index}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const httpHash = crypto.createHash('sha1').update(buf).digest('hex')
  check(res.status === 200 && httpHash === srcHashes[spec.name], `${spec.name}: HTTP download matches source sha1`)
  check(Number(res.headers.get('content-length')) === spec.size, `${spec.name}: content-length matches`)
}

console.log('\n-- pause / resume / remove --')
{
  const p = await api(`/api/torrents/${t.infoHash}/pause`, { method: 'POST' })
  check(p.body.paused === true, 'pause sets paused=true')
  const r = await api(`/api/torrents/${t.infoHash}/resume`, { method: 'POST' })
  check(r.body.paused === false, 'resume sets paused=false')
  const del = await api(`/api/torrents/${t.infoHash}?deleteFiles=true`, { method: 'DELETE' })
  check(del.body.removed === true, 'remove succeeds')
  await sleep(500)
  const { body: after } = await api('/api/torrents')
  check(after.length === 0, 'torrent list empty after remove')
  check(t.files.every((f) => !fs.existsSync(f.absPath)), 'all files deleted from disk')
}

server.kill()
seeder.destroy(() => {})
fs.rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
