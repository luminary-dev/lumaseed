# Debian slim rather than alpine: webtorrent's optional native deps
# ship prebuilt glibc binaries that don't load on musl.
FROM node:24-slim

WORKDIR /app

# patches/ must be present before npm ci — postinstall runs patch-package.
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev

COPY server.js start.js ./
COPY public ./public

ENV PORT=3456 \
    TORRENT_PORT=42069 \
    DOWNLOAD_DIR=/downloads \
    UV_THREADPOOL_SIZE=32

RUN mkdir -p /downloads && chown node:node /downloads /app
USER node
VOLUME /downloads

# 3456 = web UI, 42069 = incoming peer connections (TCP + uTP/UDP)
EXPOSE 3456 42069 42069/udp

CMD ["node", "start.js"]
