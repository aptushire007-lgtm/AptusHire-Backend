# Backend API image. Built by `docker compose --profile app up -d` from the repo root.
FROM node:22-alpine

# curl is used by container healthchecks against /api/health.
RUN apk add --no-cache curl

WORKDIR /app

# Install deps first so source edits don't bust the npm layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:9000/api/health || exit 1

CMD ["node", "server.js"]
