// Entry point. Widens the libuv threadpool BEFORE anything touches the
// filesystem so disk reads/writes for 10GB+ torrents run in parallel
// (default is 4 threads, shared by all fs operations).
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '32'
await import('./server.js')
