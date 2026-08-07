# Command Center — container image
# Linux-first; serves the dashboard on :3000. Put TLS + an authenticating
# reverse proxy (Caddy/Traefik/nginx) in front for production, or enable the
# built-in HTTPS listener with cert.pem/key.pem mounted at /app/server.
FROM node:22-bookworm-slim

# System libs for optional native deps (@napi-rs/canvas used by pdf-parse,
# image tooling). Installed so PDF extraction and rendering work in-container;
# the server still degrades gracefully if they are missing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     tini \
     ca-certificates \
     libgl1 \
     libxi6 \
     libxcursor1 \
     libxrandr2 \
     libxinerama1 \
     libpango-1.0-0 \
     libcairo2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source.
COPY . .

# Mutable runtime state lives here; mount a volume at /app/data.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DEMO_MODE=false \
    COMMANDCENTER_DATA_DIR=/app/data

VOLUME ["/app/data"]

# Healthcheck hits the lightweight /api/health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000

# tini reaps zombies and forwards signals so SIGTERM reaches Node for graceful shutdown.
ENTRYPOINT ["tini", "--"]
CMD ["node", "server/index.js"]
