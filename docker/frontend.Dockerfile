# Builds the Vite SPA into /app/dist. The compose `frontend-build` service then
# copies the output into a shared volume that Caddy serves.
FROM node:20-alpine
WORKDIR /app

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build
