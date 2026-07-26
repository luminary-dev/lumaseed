# Lumaseed

> Self-hosted torrent downloader with a browser UI. A product of [Luminary](https://luminary-dev.xyz).

A torrent downloader you run yourself and use from your web browser.

You paste a magnet link into a web page, and the file downloads onto your own computer or server at your connection's full speed. There are no accounts, no queues, no file-size caps, and no speed limits — because there's no company in the middle. It's just a small program running on hardware you control.

Think of it as a private alternative to services like Seedr or Bitport, without the subscription or the limits.

---

## What you need

- A computer or server that can stay switched on while things download (a laptop, a home server, a Raspberry Pi, or a rented VPS).
- **Docker** installed — that's the only dependency. [Install Docker](https://docs.docker.com/get-started/get-docker/) if you don't have it.
- Enough free disk space for what you're downloading.

That's it. You don't need to know Node.js or install anything else.

---

## Getting started

Download this repository, open a terminal in the folder, and run:

```bash
docker compose up -d
```

The first run takes a minute or two while it builds. After that, open:

**http://localhost:3456**

Your downloads will appear in a `downloads` folder next to these files.

To stop it:

```bash
docker compose down
```

To see what it's doing (useful if something looks wrong):

```bash
docker compose logs -f
```

### Running it without Docker

If you'd rather run it directly and you have [Node.js](https://nodejs.org) 20 or newer:

```bash
npm install
npm start
```

Same address: http://localhost:3456

---

## How to use it

**To start a download**, either paste a magnet link into the box and click *Add*, or drag a `.torrent` file onto the drop zone.

**While it downloads**, each torrent shows a progress bar, download and upload speed, how many peers it's connected to, and an estimated time remaining. You can pause, resume, or remove a torrent at any time. Removing asks whether you also want to delete the downloaded files.

**When it's finished**, you have three ways to get your files:

1. **Open the folder directly.** The files are already on the machine, in the `downloads` folder. The interface shows the full path of every file and has a copy button next to it. This is the fastest option when you're sitting at the same computer.
2. **Download folder** packages the entire torrent — folder structure and all — into a single `.zip` and sends it to your browser. Use this when you're accessing Lumaseed from a different device, like a laptop or phone.
3. **Save** next to an individual file downloads just that one file.

The zip is built without compression, because video and audio files are already compressed and squeezing them again would waste time for no benefit. It streams straight from disk, so even very large torrents download about as fast as your network allows.

There's a light/dark theme toggle in the top-right corner.

---

## Important: there is no password

Lumaseed has **no login screen**. Anyone who can reach the address can add torrents and download your files.

That's perfectly fine when you're running it on your own computer and only opening it at `localhost`. But **do not put it directly on the public internet.** If you want to use it from outside your home, the safest and simplest approach is a private network like [Tailscale](https://tailscale.com) — install it on the server and on your phone or laptop, and they can talk to each other privately without exposing anything to the world.

If you really do need it publicly reachable, put something in front of it that requires a login, such as Caddy or nginx with HTTPS and basic authentication, or Cloudflare Access.

---

## Getting the best speed

Lumaseed is already tuned for maximum throughput — nothing is throttled, and it uses far more peer connections than a default client. In practice, three things determine how fast a torrent goes:

**How many people are sharing it.** This is by far the biggest factor and it's outside anyone's control. A popular torrent with hundreds of seeders will saturate your connection. A rare one with two seeders will crawl no matter what software you use.

**Whether other people can connect to you.** Torrents are much faster when peers can reach you directly, not just when you reach out to them. Lumaseed tries to configure this automatically on home routers using UPnP. If your router has UPnP disabled, you can do it manually by forwarding port **42069** (both TCP and UDP) to the machine running Lumaseed. On a rented server, open that port in the provider's firewall instead.

**Your own connection.** A wired ethernet cable beats Wi-Fi. Some VPNs deliberately slow down file sharing, so if speeds are poor, try without it.

### If a torrent won't download at all

If it sits on "Searching for peers" forever, the torrent is probably **dead** — meaning nobody online has the file any more. When that happens, no program can download it, because the data simply isn't out there. Lumaseed keeps looking in the background for as long as it's running, so if someone does come online with the file, it will start automatically. Leaving it running overnight is worth a try; if nothing happens after a few days, the torrent is gone.

---

## Settings

You can change these in the `environment:` section of `docker-compose.yml`:

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `3456` | The address the web page is served on |
| `TORRENT_PORT` | `42069` | The port other peers connect to you on |
| `DOWNLOAD_DIR` | `/downloads` | Where files are saved inside the container |

To save downloads somewhere else on your machine — an external drive, for example — change the left-hand side of the `volumes:` line in `docker-compose.yml`:

```yaml
volumes:
  - /mnt/storage/torrents:/downloads
```

---

## Running it on a server

A few things worth knowing before you rent a VPS for this:

**It can't run on serverless platforms.** Vercel, Netlify, and AWS Lambda won't work, no matter what you add to it. A torrent client needs to keep network connections open for hours and store large files on a real disk; those platforms run short-lived functions with temporary storage. You need an actual always-on machine.

**Check your provider's rules.** Many hosting companies prohibit file sharing in their terms of service and will suspend your server if they receive a copyright complaint. Providers that specifically advertise "seedbox" hosting expect this traffic; most general-purpose clouds don't.

**Watch the bandwidth billing.** A torrent client keeps uploading to others after your download finishes, so you can use far more data than you downloaded. Choose an unmetered plan if you can.

**Torrents aren't remembered across restarts.** If the container restarts, your downloaded files are safe on disk, but the list of active torrents is cleared and you'll need to re-add the magnet links to resume. Worth knowing if you're setting this up as an always-on service.

---

## Troubleshooting

**The page won't load.** Check the container is running with `docker compose ps`, and look at `docker compose logs` for errors. If the port is already used by something else, change `PORT` in `docker-compose.yml`.

**Downloads are very slow or stuck at 0%.** Almost always a lack of seeders — check the peer count in the interface. If it says 0 peers for a long time, see the note about dead torrents above.

**I want to check my download isn't corrupted.** Every piece of a torrent is cryptographically verified before it's written to disk, so a completed download is correct by design. If you want to confirm it independently, visit `http://localhost:3456/api/verify/` followed by the torrent's info hash; it re-reads and re-checks a sample of the data and reports `"healthy": true`.

---

## For developers

Node.js and Express on the server, [webtorrent](https://github.com/webtorrent/webtorrent) as the BitTorrent engine, and a single dependency-free HTML file for the interface (self-hosted fonts and icons, so it works with no internet access).

Run the test suite with `npm test`. It spins up a real seeder, downloads a multi-file torrent through the actual server, and checks every number the interface displays against ground truth on disk — including that reported progress matches the bytes actually written, that files verify by SHA-1, and that the zip download extracts correctly.

Two patches are applied automatically to dependencies on install:

- **`patches/bittorrent-protocol+5.0.7.patch`** — the significant one. Its JavaScript RC4 implementation encrypted buffers *in place*, and webtorrent passes it the client's live piece bitfield when greeting each peer. Because BitTorrent protocol encryption is enabled by default, every encrypted handshake corrupted the client's own record of which pieces it held. The visible effect was progress climbing to a phantom ~50% with nothing on disk, and downloads stalling because the client thought it already had those pieces. The cipher now returns a new buffer, matching Node's native RC4 behaviour.
- **`patches/webtorrent+3.0.16.patch`** — sends a copy of the bitfield to the wire as a second line of defence, fixes null-piece crashes in the piece selector and request path, and dials peers over TCP first.

Progress, speeds, and time remaining are all computed server-side from verified byte counts and weighted by file size, never derived from file counts or trusted from library getters.

---

## Legal

Only download content you have the legal right to. You are responsible for what you do with this software.

## License

MIT

---

**Website:** [lumaseed.luminary-dev.xyz](https://lumaseed.luminary-dev.xyz) · **Docs:** [/docs](https://lumaseed.luminary-dev.xyz/docs)
