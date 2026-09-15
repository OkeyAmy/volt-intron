# Full Sautice app WITH voice: the custom Node server (web/server.mts) holds the
# WebSocket gateway to Sahara, which a serverless platform (Vercel) cannot host.
# Deploy this image to any container host that supports WebSockets (Render, Railway,
# Fly.io, Cloud Run). Set INTRON_API_KEY (Sahara) and DATABASE_URL (Postgres/Neon).
FROM node:22-slim

RUN corepack enable
WORKDIR /app

# Install deps first for layer caching (devDeps included: build needs next/tsx).
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# App source, then the production build. NODE_ENV=production is set AFTER install so
# devDeps (next/tsx/typescript) are present for the build, then the runtime is prod.
COPY web/ ./
ENV NODE_ENV=production
RUN pnpm run build

ENV PORT=3000
EXPOSE 3000
# `start` runs the custom server (tsx server.mts): the Next app + the
# /api/voice/stream WebSocket gateway on one port. Voice is ON by default.
CMD ["pnpm", "run", "start"]
