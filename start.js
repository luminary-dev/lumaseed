// Supervisor entry point.
//
// Widens the libuv threadpool BEFORE anything touches the filesystem so disk
// reads/writes for 10GB+ torrents run in parallel (default is 4 threads), then
// runs the server in a child process and restarts it if it dies. Native
// dependencies can abort the process from C++ (uncatchable from JS), and a
// long download should survive that — torrents resume from disk on restart.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(__dirname, 'server.js')

let shuttingDown = false
let restarts = 0
let child = null

function run() {
  child = spawn(process.execPath, [SERVER], {
    stdio: 'inherit',
    env: { UV_THREADPOOL_SIZE: '32', ...process.env }
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    // A clean exit(0) or a fatal startup error (exit 1, e.g. port in use)
    // is intentional — do not fight it with a restart loop.
    if (code === 0 || code === 1) process.exit(code ?? 0)
    restarts++
    console.error(`[supervisor] server exited (${signal || `code ${code}`}); restart #${restarts} in 2s`)
    setTimeout(run, 2000)
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shuttingDown = true
    if (child) child.kill(sig)
    setTimeout(() => process.exit(0), 4000).unref()
  })
}

run()
