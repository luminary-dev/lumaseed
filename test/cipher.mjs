/*
 * Regression test for the bug that silently faked ~50% download progress.
 *
 * bittorrent-protocol's JS RC4 fallback (used whenever Node lacks native RC4 —
 * i.e. Node 17+ without --openssl-legacy-provider) XOR-ed its input buffer
 * IN PLACE. webtorrent passes its live piece bitfield to wire.bitfield(),
 * which flows straight into that cipher, so every encrypted peer handshake
 * scrambled the client's own bitfield into pseudorandom bits. The client then
 * believed it held pieces it had never downloaded: progress jumped toward
 * ~50%, and the download stalled because it stopped requesting those pieces.
 *
 * Protocol encryption is ON BY DEFAULT (webtorrent `secure: 1`), so this hit
 * every real-world torrent. Here we force RC4-only encryption (`secure: 2`)
 * and assert the downloader's own bitfield stays honest.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

let failures = 0
function check(cond, label, detail = '') {
  if (cond) console.log(`  ok    ${label}`)
  else { failures++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('-- JS RC4 fallback must not mutate its input --')
{
  const src = fs.readFileSync(path.join(ROOT, 'node_modules/bittorrent-protocol/mse.js'), 'utf8')
  check(!/buf\[i\] \^= /.test(src), 'cipher does not XOR the caller buffer in place')
}

console.log('\n-- encrypted transfer keeps the bitfield honest --')

const { default: WebTorrent } = await import(path.join(ROOT, 'node_modules/webtorrent/index.js'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-mse-'))
const seedDir = path.join(tmp, 'payload')
fs.mkdirSync(seedDir)
const SIZE = 24 * 1024 * 1024
fs.writeFileSync(path.join(seedDir, 'data.bin'), crypto.randomBytes(SIZE))

const SEED_PORT = 53911
// secure: 2 = protocol encryption, RC4 only (no plaintext fallback).
const seeder = new WebTorrent({ torrentPort: SEED_PORT, dht: false, tracker: false, lsd: false, utp: false, secure: 2 })
seeder.on('error', () => {})
const st = await new Promise((r) => seeder.seed(seedDir, { announce: [] }, r))

const dl = new WebTorrent({ torrentPort: SEED_PORT + 1, dht: false, tracker: false, lsd: false, utp: false, secure: 2 })
dl.on('error', () => {})
const dlDir = path.join(tmp, 'dl')
const t = dl.add(`magnet:?xt=urn:btih:${st.infoHash}&x.pe=127.0.0.1:${SEED_PORT}`, { path: dlDir })
t.on('error', () => {})

// Watch for the bitfield ever claiming more than the client has actually
// received — the exact signature of the corruption.
let bogus = false
let sawEncryptedWire = false
const timer = setInterval(() => {
  if (!t.bitfield || !t.pieces.length) return
  if (t.wires.some((w) => w._cryptoHandshakeDone)) sawEncryptedWire = true
  let set = 0
  for (let i = 0; i < t.pieces.length; i++) if (t.bitfield.get(i)) set++
  // Verified pieces can never exceed what the wire has actually delivered.
  if (set * t.pieceLength > t.received + t.pieceLength) bogus = true
}, 200)

const done = await new Promise((resolve) => {
  const to = setTimeout(() => resolve(false), 120000)
  t.on('done', () => { clearTimeout(to); resolve(true) })
})
clearInterval(timer)

check(sawEncryptedWire, 'peer connection was actually RC4-encrypted')
check(!bogus, 'bitfield never claims more pieces than bytes received')
check(done, 'encrypted download completes')

if (done) {
  const out = path.join(dlDir, 'payload', 'data.bin')
  const src = crypto.createHash('sha1').update(fs.readFileSync(path.join(seedDir, 'data.bin'))).digest('hex')
  const got = crypto.createHash('sha1').update(fs.readFileSync(out)).digest('hex')
  check(src === got, 'file transferred over encrypted wire matches source sha1')
}

await new Promise((r) => dl.destroy(r))
await new Promise((r) => seeder.destroy(r))
fs.rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
