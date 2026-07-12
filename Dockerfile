# LazyClips — runs as a normal long-lived container (needs FFmpeg + a writable
# disk + minutes-long renders, so it belongs on a container/VM, not serverless).
FROM node:22-bookworm-slim

# FFmpeg/ffprobe for probing, frame sampling, and rendering; DejaVu fonts for the
# drawtext fallback (the primary text path is rendered in the user's browser).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only production deps, cached separately from the source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Runtime data (uploads, thumbnails, outputs, render scratch, registry) lives
# here; mount a volume at /app/data to persist it. Owned by the unprivileged
# `node` user that ships with the base image.
RUN mkdir -p data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=4173
EXPOSE 4173

CMD ["node", "server.js"]
