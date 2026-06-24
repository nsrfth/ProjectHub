# Builds the Vite SPA into /app/dist. The compose `frontend-build` service then
# copies the output into a shared volume that Caddy serves.
#
# v1.10.1: build context is the REPO ROOT (not ./frontend) so the prebuild
# step in frontend/scripts/copy-manual.mjs can pull USER_MANUAL.md in from
# the workspace root. Inside the image we lay out:
#   /app          ← frontend/   (everything Vite needs)
#   /USER_MANUAL.md  ← copied from repo root, read by the prebuild script
#                    via the path '../USER_MANUAL.md' relative to /app/.
FROM node:20-alpine
WORKDIR /app

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# Manifests first for layer caching.
COPY frontend/package.json frontend/package-lock.json* ./
# `npm ci` has been flaky in Docker Desktop (incomplete node_modules, sharp
# missing). Install + verify sharp is present before the build step runs.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm install --no-audit --no-fund \
  && test -f node_modules/sharp/package.json

# v1.13: both manuals (EN canonical + FA translation) sit one level up so
# copy-manual.mjs resolves them via '..'. FA is optional — the script
# tolerates it being absent.
COPY USER_MANUAL.md /USER_MANUAL.md
COPY USER_MANUAL.fa.md /USER_MANUAL.fa.md

# Everything else from the frontend dir. CACHEBUST invalidates this layer on
# demand (`docker compose build --build-arg CACHEBUST=$(date +%s) frontend-build`).
ARG CACHEBUST=1
RUN echo "frontend source cache bust: ${CACHEBUST}"
COPY frontend/ .

RUN npm run build
