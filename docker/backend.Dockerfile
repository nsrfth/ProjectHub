# Multi-stage build for the Fastify backend.
# Stage 1: install + build TS.
FROM node:20-alpine AS builder
WORKDIR /app

# OpenSSL is required by Prisma's database engine on Alpine.
RUN apk add --no-cache openssl

# Install deps using package manifests first (better layer caching).
COPY package.json package-lock.json* ./
# NODE_ENV=development ensures devDeps (prisma CLI) are installed even when
# the host .env passes NODE_ENV=production into the build context.
RUN NODE_ENV=development npm ci

COPY prisma ./prisma
RUN ./node_modules/.bin/prisma generate

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
# Needed for `npx prisma db seed` (used by install.sh and manual re-seeds):
# package.json carries the `prisma.seed` command, and the tsx seeder imports
# from src/ (e.g. prisma/seed.ts -> ../src/lib/systemUser.js). tsconfig.json
# provides the path/module resolution tsx honours.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src

# Pre-create /app/uploads + /app/backups + /app/kopia-secrets so the named-volume
# mounts inherit their ownership (named volumes copy ownership from the image's
# matching path on first mount). The backend, which runs as `app`, writes the
# Kopia config/secrets into /app/kopia-secrets (v2.5.37).
RUN mkdir -p /app/uploads /app/backups /app/kopia-secrets && chown -R app:app /app
USER app

EXPOSE 4000
# Run migrations on startup, then the server.
CMD ["sh", "-c", "npx prisma@5 migrate deploy && node dist/server.js"]