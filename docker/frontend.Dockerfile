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
RUN npm ci

# v1.13: both manuals (EN canonical + FA translation) sit one level up so
# copy-manual.mjs resolves them via '..'. FA is optional — the script
# tolerates it being absent.
COPY USER_MANUAL.md /USER_MANUAL.md
COPY USER_MANUAL.fa.md /USER_MANUAL.fa.md

# Everything else from the frontend dir.
COPY frontend/ .

RUN npm run build
