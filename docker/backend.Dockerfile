# Multi-stage build for the Fastify backend.
# Stage 1: install + build TS.
FROM node:20-alpine AS builder
WORKDIR /app

# OpenSSL is required by Prisma's database engine on Alpine.
RUN apk add --no-cache openssl

# Install deps using package manifests first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma@5 generate

COPY tsconfig.json ./
COPY scripts/copy-data.mjs scripts/generate-ir-holidays.mjs ./scripts/
COPY src ./src
RUN npm run build

# Stage 2: production image.
FROM node:20-alpine AS runner
WORKDIR /app

# OpenSSL is required by Prisma's database engine on Alpine.
# postgresql16-client added in v1.27 so pg_dump is available to the
# automatic-backup scheduler. Matches the major version of the postgres:16
# server image so dump formats stay compatible.
RUN apk add --no-cache openssl postgresql16-client

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
# Copy the full node_modules from the builder (already has prisma generated)
# instead of running npm ci again in the runner — avoids @prisma/client
# postinstall re-running prisma generate without a schema file present.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Pre-create /app/uploads + /app/backups so the named-volume mounts inherit
# their ownership (named volumes copy ownership from the image's matching
# path on first mount).
RUN mkdir -p /app/uploads /app/backups && chown -R app:app /app
USER app

EXPOSE 4000
# Run migrations on startup, then the server.
CMD ["sh", "-c", "npx prisma@5 migrate deploy && node dist/server.js"]