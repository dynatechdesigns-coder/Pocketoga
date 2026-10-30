# PocketOga: one Docker service serving the API and the built web app on the
# same origin (Render free plan). Same Node major as local dev (node:sqlite
# needs it), plus ffmpeg for WhatsApp voice notes.
FROM node:24-bookworm-slim

# ffmpeg for voice-note conversion (16 kHz mono WAV for the audio model).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend has zero runtime dependencies; install only what each side needs.
COPY package.json ./
COPY web/package*.json web/
RUN cd web && (npm ci || npm install)

# Build the web app against a relative API base: same origin, no CORS.
# (VITE_API_BASE="" makes api.js call the server it was served from.)
COPY web/ web/
RUN cd web && VITE_API_BASE="" npm run build
# Fail the image build loudly when the frontend did not build: without
# web/dist the server runs API-only and "/" answers the shop-header error.
RUN test -f web/dist/index.html

# Backend sources only: no tests, scripts, audio, or local state.
COPY *.mjs ./

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "server.mjs"]
