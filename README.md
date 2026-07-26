# TorrentBox

Self-hosted torrent downloader with a browser UI. Runs on **your** machine and **your** connection — no speed caps, no file-size limits, no queues.

## Run with Docker (recommended)

```bash
docker compose up -d
```

Then open **http://localhost:3456**. Downloads land in `./downloads` on the host.

Or without compose:

```bash
docker build -t torrentbox .
docker run -d --name torrentbox \
  -p 3456:3456 -p 42069:42069 -p 42069:42069/udp \
  -v "$(pwd)/downloads:/downloads" \
  torrentbox
```

On Linux, `--network host` gives the best peer connectivity (skips NAT inside Docker):

```bash
docker run -d --name torrentbox --network host -v "$(pwd)/downloads:/downloads" torrentbox
```

Tip: forwarding TCP/UDP port `42069` on your router to the machine running TorrentBox makes you connectable to more peers, which matters most on poorly-seeded torrents.

## Run with Node directly

```bash
npm install   # first time only
npm start
```

Then open **http://localhost:3456**.

## Use it

- Paste a **magnet link** and hit Add torrent, or
- Drop a **.torrent file** onto the drop zone (or click it to browse).

Files download to the downloads directory. Once a file hits 100% you can also click **Save** next to it in the UI to pull it through the browser (Range-supported, so 10GB+ files are fine).

Pause / resume / remove per torrent. Removing asks whether to also delete the data from disk.

## Speed

The engine is configured for maximum throughput out of the box:

- **No throttling anywhere** — download/upload limits are explicitly disabled.
- **200 peer connections per torrent** (default is 55) and 10 parallel web-seed connections.
- **TCP-first peer dialing** (patched) — stock webtorrent dials uTP first and burns ~40 seconds of timeouts per TCP-only peer before falling back; we dial TCP instantly and fall back to uTP instead, keeping uTP for the peers that need it.
- **DHT with 4× lookup concurrency**, PEX, local-network discovery, and 13 public trackers on every torrent.
- **Automatic router port mapping** (UPnP + NAT-PMP) for the peer port, so inbound peers can reach you — being connectable is the single biggest real-world speed factor. If your router doesn't support either, forward TCP+UDP `42069` manually.
- **32 disk I/O threads** (`UV_THREADPOOL_SIZE`) so hashing and writing 10GB+ files doesn't queue behind 4 default threads.

What's left that only you can control: your ISP line rate, VPNs that throttle P2P, Wi-Fi vs ethernet, and — above all — how many seeders the torrent has. A torrent's swarm upload capacity is a hard ceiling no client can exceed.

## Notes on dead / low-seed torrents

- A torrent with **zero seeders and no complete peer swarm cannot be downloaded by anything** — the data simply isn't on the network.
- What helps rare torrents: this client stays connected to **DHT + PEX + a set of public trackers** the whole time the server runs, so it grabs pieces the moment any peer shows up. Leave it running.
- "Searching for peers" that never turns into a download for days usually means the torrent is genuinely dead.

## Config

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3456` | Web UI port |
| `TORRENT_PORT` | random (fixed to `42069` in Docker) | Listen port for incoming peers |
| `DOWNLOAD_DIR` | `./downloads` (`/downloads` in Docker) | Where files are saved |

## Testing

```bash
npm test
```

Runs an end-to-end suite that seeds a locally-generated 150MB torrent, downloads it through the real server over loopback, and asserts on every stat the UI shows: progress equals downloaded/length on every poll and never regresses or leaves [0,1], ETA is finite while transferring and 0 at completion, final byte counts are exact, and both the on-disk file and the HTTP download hash-match the source. Also covers duplicate detection, pause/resume, and remove-with-delete.

## Implementation notes

- Node + Express + [webtorrent](https://github.com/webtorrent/webtorrent) v3 (full TCP/UDP peer support, DHT, PEX — not the browser-only WebRTC variant).
- `patches/webtorrent+3.0.16.patch` (applied automatically via `patch-package` on `npm install`) fixes null-piece races in webtorrent's piece selector and progress getters that crash or corrupt progress when resuming partial data, and switches outgoing peer dialing to TCP-first with uTP fallback (stock is uTP-first with a ~40s penalty per TCP-only peer).
- UI: dependency-free vanilla HTML/CSS/JS in the Luminary design language (Outfit + JetBrains Mono, lime accent, light/dark themes) with self-hosted fonts and Phosphor icons — works fully offline. Stats (progress, ETA, speeds) are computed server-side from verified byte counts and clamped, never trusted from library getters.
- **No authentication built in.** Fine on localhost or a LAN you trust; put a reverse proxy with auth in front before exposing it further.

Only download content you have the rights to.
