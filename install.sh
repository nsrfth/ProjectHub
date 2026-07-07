#!/usr/bin/env bash
# TaskHub interactive installer (Linux / macOS / WSL).
#
# Walks through a fresh install: prompts for the values that need a human
# decision (site host, admin email, admin password), auto-generates the rest
# (JWT secrets, MASTER_KEY, Postgres password) with offers to override, writes
# `.env`, brings the compose stack up, waits for the backend to be healthy,
# and seeds the database with the chosen admin credentials.
#
# Optional integrations (SMTP, LDAP, schedulers) are intentionally NOT
# prompted — the installer writes sensible "off" defaults so you can flip
# them by editing `.env` later. See INSTALL.md § "Optional integrations".

set -euo pipefail

#--------------------------------------------------------------------- helpers
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; NC=$'\033[0m'

err() { printf '%s\n' "${RED}error:${NC} $*" >&2; }
note() { printf '%s\n' "${BOLD}$*${NC}"; }
ok() { printf '%s\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%s\n' "${YELLOW}!${NC} $*"; }

# Read a line, show a default in [brackets]. Empty input → default.
ask() {
  local prompt="$1"; local default="${2:-}"; local reply
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " reply
    printf '%s' "${reply:-$default}"
  else
    while true; do
      read -r -p "$prompt: " reply
      if [[ -n "$reply" ]]; then printf '%s' "$reply"; return; fi
    done
  fi
}

# Silent read for passwords. Echo a newline because read -s eats it.
ask_secret() {
  local prompt="$1"; local default="${2:-}"; local reply
  read -r -s -p "$prompt${default:+ [generated]}: " reply
  echo
  printf '%s' "${reply:-$default}"
}

yn() {
  local prompt="$1"; local default="${2:-N}"; local reply
  read -r -p "$prompt [y/N]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# 32-byte random secrets. base64 for JWT (long printable), hex for MASTER_KEY
# (the env validator demands exactly 64 lowercase-hex chars).
gen_base64() { openssl rand -base64 48 | tr -d '\n'; }
gen_hex() { openssl rand -hex 32; }

# A URL-safe DB password — no `@:/?#` so it doesn't need URL-encoding inside
# DATABASE_URL.
gen_db_password() { openssl rand -base64 24 | tr -d '/+=\n' | head -c 24; }

#--------------------------------------------------------------------- preflight
note "TaskHub installer"
echo

if ! command -v docker >/dev/null 2>&1; then
  err "docker not found in PATH. Install Docker Engine 24+ first."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose (v2) not available. Update Docker."
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  err "openssl not found. Install it (apt: openssl, brew: openssl@3)."
  exit 1
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$REPO_ROOT"

if [[ ! -f .env.example ]]; then
  err "Run this from the TaskHub repo root (no .env.example found here)."
  exit 1
fi

if [[ -f .env ]]; then
  warn ".env already exists."
  if ! yn "Back it up and overwrite?"; then
    err "Aborted by user."
    exit 1
  fi
  cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
  ok "Backed up existing .env"
fi

#--------------------------------------------------------------------- prompts
echo
note "1/4 — Public hostname"
echo "   real hostname → Caddy obtains a Let's Encrypt cert automatically."
echo "   :80           → local-only HTTP (LAN / dev). No cert."
SITE_HOST=$(ask "Site host" ":80")

ACME_EMAIL=""
if [[ "$SITE_HOST" != ":80" && "$SITE_HOST" != :* ]]; then
  ACME_EMAIL=$(ask "ACME (Let's Encrypt) contact email")
fi

# Derived:
#  - COOKIE_SECURE: required true for HTTPS (Caddy serves), false for :80
#  - CORS_ORIGINS:  the origin the SPA is served from
#  - PUBLIC_APP_URL: same origin, used for links in outbound emails
if [[ "$SITE_HOST" == :* ]]; then
  COOKIE_SECURE=false
  CORS_ORIGINS="http://localhost${SITE_HOST}"
  PUBLIC_APP_URL="http://localhost${SITE_HOST}"
else
  COOKIE_SECURE=true
  CORS_ORIGINS="https://${SITE_HOST}"
  PUBLIC_APP_URL="https://${SITE_HOST}"
fi

echo
note "2/4 — Database password"
echo "   Press Enter to auto-generate a 24-char random password."
POSTGRES_PASSWORD=$(ask_secret "Postgres password" "$(gen_db_password)")
# Strip any stray CR/LF/whitespace so it can never split the DATABASE_URL line
# in .env (a lone newline here wraps the URL and breaks docker compose's env
# parser: `unexpected character "@" in variable name`).
POSTGRES_PASSWORD=$(printf '%s' "$POSTGRES_PASSWORD" | tr -d '\r\n[:space:]')

echo
note "3/4 — First admin user"
ADMIN_EMAIL=$(ask "Admin email" "admin@taskhub.local")
while true; do
  pw=$(ask_secret "Admin password (Enter to auto-generate)" "")
  if [[ -z "$pw" ]]; then
    pw=$(openssl rand -base64 12 | tr -d '/+=\n' | head -c 16)
    ADMIN_PASSWORD="$pw"
    ADMIN_GENERATED=1
    break
  fi
  # Same policy as backend/src/schemas/auth.ts: ≥ 12 chars, ≥ 1 letter + 1 digit
  if (( ${#pw} < 12 )) || ! [[ "$pw" =~ [A-Za-z] && "$pw" =~ [0-9] ]]; then
    warn "Password must be ≥12 chars and contain a letter + a digit. Try again."
    continue
  fi
  ADMIN_PASSWORD="$pw"
  ADMIN_GENERATED=0
  break
done

echo
note "4/4 — Secrets (auto-generated)"
JWT_ACCESS_SECRET=$(gen_base64)
JWT_REFRESH_SECRET=$(gen_base64)
MASTER_KEY=$(gen_hex)
ok "JWT secrets + MASTER_KEY generated"

#--------------------------------------------------------------------- .env
note "Writing .env …"
DATABASE_URL="postgresql://taskhub:${POSTGRES_PASSWORD}@postgres:5432/taskhub?schema=public"

cat > .env <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).

# --- Postgres ---
POSTGRES_USER=taskhub
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
POSTGRES_DB=taskhub

# --- Backend ---
NODE_ENV=production
PORT=4000
DATABASE_URL="${DATABASE_URL}"
REDIS_URL=redis://redis:6379

JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

COOKIE_DOMAIN=
COOKIE_SECURE=${COOKIE_SECURE}

CORS_ORIGINS=${CORS_ORIGINS}

UPLOAD_MAX_BYTES=10485760
UPLOAD_DIR=/app/uploads

AUTH_RATE_LIMIT_MAX=10
AUTH_RATE_LIMIT_WINDOW=1 minute

# Symmetric at-rest key for LDAP bind passwords, TOTP secrets, webhook
# secrets. Back it up SEPARATELY from Postgres — losing it makes those
# values unrecoverable.
MASTER_KEY=${MASTER_KEY}

# --- Background schedulers (off by default — flip to true on ONE replica) ---
TASK_DUE_ENABLED=false
WEBHOOK_DISPATCH_ENABLED=false
RECURRENCE_ENABLED=false

# --- SMTP (leave SMTP_HOST blank to disable outbound mail entirely) ---
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
PUBLIC_APP_URL=${PUBLIC_APP_URL}

# --- Update check (off by default — opt in to phone GitHub for the latest release) ---
UPDATE_CHECK_ENABLED=false
UPDATE_CHECK_CACHE_HOURS=6

# --- Frontend (build-time) ---
VITE_API_BASE_URL=/api

# --- Caddy ---
SITE_HOST=${SITE_HOST}
ACME_EMAIL=${ACME_EMAIL}
EOF
chmod 600 .env || true
ok ".env written (mode 600)"

#--------------------------------------------------------------------- compose
echo
note "Building images and starting the stack — this can take 1–3 minutes…"
docker compose up -d --build

# Wait for backend health. /api/health is a tiny no-auth endpoint that returns
# {"status":"ok"} once Fastify is listening + prisma migrate deploy has
# finished. Poll for up to ~120 s.
echo
note "Waiting for backend to become healthy…"
ATTEMPTS=0
while (( ATTEMPTS < 60 )); do
  if docker compose exec -T backend wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1; then
    ok "Backend is up"
    break
  fi
  ATTEMPTS=$(( ATTEMPTS + 1 ))
  sleep 2
done
if (( ATTEMPTS >= 60 )); then
  err "Backend did not become healthy in ~120 s."
  err "Check: docker compose logs backend"
  exit 1
fi

#--------------------------------------------------------------------- seed
echo
note "Seeding the database with the chosen admin credentials…"
docker compose exec -T \
  -e SEED_ADMIN_EMAIL="${ADMIN_EMAIL}" \
  -e SEED_ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  backend npx prisma db seed
ok "Seed complete"

#--------------------------------------------------------------------- finale
echo
echo "${GREEN}${BOLD}╭──────────────────────────────────────────────────╮${NC}"
echo "${GREEN}${BOLD}│  TaskHub is ready.                               │${NC}"
echo "${GREEN}${BOLD}╰──────────────────────────────────────────────────╯${NC}"
echo
if [[ "$SITE_HOST" == :* ]]; then
  echo "  URL:      http://localhost${SITE_HOST}/"
else
  echo "  URL:      https://${SITE_HOST}/"
fi
echo "  Email:    ${ADMIN_EMAIL}"
if (( ADMIN_GENERATED == 1 )); then
  echo "  Password: ${BOLD}${ADMIN_PASSWORD}${NC}  ${YELLOW}(generated — copy it now)${NC}"
else
  echo "  Password: (the value you entered)"
fi
echo
echo "  Demo team also created with three members @taskhub.local /"
echo "  password 'demo1234'. Delete them from Admin → Users once you've"
echo "  added your real teammates."
echo
echo "  Next steps:"
echo "    - Sign in and change the admin password under Settings → Security."
echo "    - Enable optional features in .env (SMTP, schedulers): see INSTALL.md."
echo "    - Set up backups: see BACKUP.md."
