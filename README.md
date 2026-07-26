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

## Implementation notes

- Node + Express + [webtorrent](https://github.com/webtorrent/webtorrent) v3 (full TCP/UDP peer support, DHT, PEX — not the browser-only WebRTC variant).
- `patches/webtorrent+3.0.16.patch` fixes null-piece races in webtorrent's piece selector and progress getters that crash or corrupt progress when resuming a torrent with existing partial data (applied automatically via `patch-package` on `npm install`).
- UI: dependency-free vanilla HTML/CSS/JS, self-hosted Geist fonts and Phosphor icons — works fully offline.
- **No authentication built in.** Fine on localhost or a LAN you trust; put a reverse proxy with auth in front before exposing it further.

Only download content you have the rights to.
