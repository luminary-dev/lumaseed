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
const FILE_SIZE = 150 * 1024 * 1024 // 150 MB — a few seconds of loopback transfer

let failures = 0
function check(cond, label, detail = '') {
  if (cond) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-test-'))
const seedDir = path.join(tmp, 'seed')
const dlDir = path.join(tmp, 'dl')
fs.mkdirSync(seedDir)
fs.mkdirSync(dlDir)

console.log('creating 150MB test file…')
const srcPath = path.join(seedDir, 'testfile.bin')
{
  const fd = fs.openSync(srcPath, 'w')
  const chunk = 4 * 1024 * 1024
  for (let written = 0; written < FILE_SIZE; written += chunk) {
    fs.writeSync(fd, crypto.randomBytes(Math.min(chunk, FILE_SIZE - written)))
  }
  fs.closeSync(fd)
}
const srcHash = crypto.createHash('sha1').update(fs.readFileSync(srcPath)).digest('hex')

console.log('starting seeder…')
const { default: WebTorrent } = await import(path.join(ROOT, 'node_modules/webtorrent/index.js'))
const seeder = new WebTorrent({ torrentPort: SEED_PORT, dht: false, tracker: false, lsd: false, utp: false })
seeder.on('error', (e) => console.error('[seeder]', e.message))
const seedTorrent = await new Promise((resolve) => {
  seeder.seed(srcPath, { announce: [] }, resolve)
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
check(monotonic, 'downloaded bytes never regress')
check(sawTransfer, 'observed active transfer (speed > 1 MB/s)')
check(etaOkWhileMoving, 'eta finite and >= 0 whenever downloading')
if (t && t.done) {
  check(t.progress === 1, 'final progress is exactly 1', `got ${t.progress}`)
  check(t.downloaded === t.length, 'final downloaded === length', `${t.downloaded} vs ${t.length}`)
  check(t.length === FILE_SIZE, 'reported length matches real file size', `${t.length} vs ${FILE_SIZE}`)
  check(t.timeRemaining === 0, 'final eta is 0', `got ${t.timeRemaining}`)
  check(t.files.every((f) => f.done && f.progress === 1), 'all files done at completion')
  check(t.files[0].absPath.startsWith(dlDir), 'file absPath points into download dir', t.files[0].absPath)
}

console.log('\n-- data integrity --')
{
  const diskPath = t.files[0].absPath
  const diskHash = crypto.createHash('sha1').update(fs.readFileSync(diskPath)).digest('hex')
  check(diskHash === srcHash, 'file on disk matches source sha1')

  const res = await fetch(`${BASE}/api/torrents/${t.infoHash}/files/0`)
  check(res.status === 200, 'HTTP file download returns 200', `got ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const httpHash = crypto.createHash('sha1').update(buf).digest('hex')
  check(httpHash === srcHash, 'HTTP-downloaded file matches source sha1')
  check(Number(res.headers.get('content-length')) === FILE_SIZE, 'content-length matches file size')
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
  check(!fs.existsSync(t.files[0].absPath), 'file deleted from disk')
}

server.kill()
seeder.destroy(() => {})
fs.rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
