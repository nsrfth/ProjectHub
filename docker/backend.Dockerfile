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
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: production image.
FROM node:20-alpine AS runner
WORKDIR /app

# OpenSSL is required by Prisma's database engine on Alpine.
RUN apk add --no-cache openssl

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads && chown -R app:app /app
USER app

EXPOSE 4000
# Run migrations on startup, then the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]