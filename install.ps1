# TaskHub interactive installer (Windows PowerShell 5+).
#
# Mirrors install.sh: prompts for the values that need a human decision
# (site host, admin email, admin password), auto-generates the rest
# (JWT secrets, MASTER_KEY, Postgres password) with offers to override,
# writes `.env`, brings the compose stack up, waits for the backend, then
# seeds with the chosen admin credentials.
#
# Optional integrations (SMTP, LDAP, schedulers) are NOT prompted — the
# installer writes "off" defaults. Edit `.env` later. See INSTALL.md.
#
# Usage:  .\install.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ── helpers ───────────────────────────────────────────────────────────────
function Write-Note ($msg) { Write-Host $msg -ForegroundColor White }
function Write-Ok   ($msg) { Write-Host ("[OK] " + $msg) -ForegroundColor Green }
function Write-Warn ($msg) { Write-Host ("[!]  " + $msg) -ForegroundColor Yellow }
function Write-Err  ($msg) { Write-Host ("[X]  " + $msg) -ForegroundColor Red }

function Ask {
    param([string]$Prompt, [string]$Default = '')
    if ($Default) {
        $reply = Read-Host "$Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($reply)) { return $Default } else { return $reply }
    }
    do { $reply = Read-Host $Prompt } while ([string]::IsNullOrWhiteSpace($reply))
    return $reply
}

function Ask-Secret {
    param([string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try   { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Ask-YN {
    param([string]$Prompt, [string]$Default = 'N')
    $reply = Read-Host "$Prompt [y/N]"
    if ([string]::IsNullOrWhiteSpace($reply)) { $reply = $Default }
    return ($reply -match '^[Yy]')
}

# Cryptographically random bytes via .NET RNG.
function New-RandomBytes {
    param([int]$Length)
    $bytes = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try   { $rng.GetBytes($bytes); return $bytes }
    finally { $rng.Dispose() }
}

# 48 random bytes → 64 base64 chars. Right shape for the env validator's
# `min(32)` rule.
function New-Base64Secret {
    return [Convert]::ToBase64String((New-RandomBytes -Length 48))
}

# 32 random bytes → exactly 64 lowercase-hex chars. The env validator demands
# this exact shape for MASTER_KEY.
function New-HexKey {
    $bytes = New-RandomBytes -Length 32
    return -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
}

# URL-safe DB password (no @ : / ? # = + & so it doesn't need URL-encoding
# inside DATABASE_URL).
function New-DbPassword {
    $bytes = New-RandomBytes -Length 24
    $b64   = [Convert]::ToBase64String($bytes)
    $clean = $b64 -replace '[+/=]', ''
    if ($clean.Length -lt 16) { return New-DbPassword }   # exceptionally rare
    return $clean.Substring(0, 24)
}

# ── preflight ─────────────────────────────────────────────────────────────
Write-Note ''
Write-Note 'TaskHub installer'
Write-Note ''

try { docker version | Out-Null } catch {
    Write-Err 'docker not found in PATH. Install Docker Desktop / Engine 24+ first.'
    exit 1
}
try { docker compose version | Out-Null } catch {
    Write-Err 'docker compose (v2) not available. Update Docker.'
    exit 1
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

if (-not (Test-Path '.env.example')) {
    Write-Err 'Run this from the TaskHub repo root (no .env.example found here).'
    exit 1
}

if (Test-Path '.env') {
    Write-Warn '.env already exists.'
    if (-not (Ask-YN 'Back it up and overwrite?')) {
        Write-Err 'Aborted by user.'
        exit 1
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item '.env' ".env.bak.$stamp"
    Write-Ok "Backed up existing .env to .env.bak.$stamp"
}

# ── prompts ───────────────────────────────────────────────────────────────
Write-Host ''
Write-Note '1/4 - Public hostname'
Write-Host '   real hostname -> Caddy gets a Let''s Encrypt cert automatically.'
Write-Host '   :80           -> local-only HTTP (LAN / dev). No cert.'
$SITE_HOST = Ask 'Site host' ':80'

$ACME_EMAIL = ''
if (-not $SITE_HOST.StartsWith(':')) {
    $ACME_EMAIL = Ask 'ACME (Let''s Encrypt) contact email'
}

# Derived from SITE_HOST.
if ($SITE_HOST.StartsWith(':')) {
    $COOKIE_SECURE   = 'false'
    $CORS_ORIGINS    = "http://localhost$SITE_HOST"
    $PUBLIC_APP_URL  = "http://localhost$SITE_HOST"
} else {
    $COOKIE_SECURE   = 'true'
    $CORS_ORIGINS    = "https://$SITE_HOST"
    $PUBLIC_APP_URL  = "https://$SITE_HOST"
}

Write-Host ''
Write-Note '2/4 - Database password'
Write-Host '   Press Enter to auto-generate a 24-char random password.'
$pgInput = Ask-Secret 'Postgres password (Enter to auto-generate)'
if ([string]::IsNullOrWhiteSpace($pgInput)) {
    $POSTGRES_PASSWORD = New-DbPassword
    Write-Ok 'Postgres password generated.'
} else {
    $POSTGRES_PASSWORD = $pgInput
}

Write-Host ''
Write-Note '3/4 - First admin user'
$ADMIN_EMAIL = Ask 'Admin email' 'admin@taskhub.local'

$ADMIN_GENERATED = $false
while ($true) {
    $pw = Ask-Secret 'Admin password (Enter to auto-generate)'
    if ([string]::IsNullOrWhiteSpace($pw)) {
        $bytes = New-RandomBytes -Length 12
        $pw = ([Convert]::ToBase64String($bytes) -replace '[+/=]', '').Substring(0, 16)
        $ADMIN_PASSWORD = $pw
        $ADMIN_GENERATED = $true
        break
    }
    # Match backend/src/schemas/auth.ts: >= 12 chars, has letter + digit.
    if ($pw.Length -lt 12 -or $pw -notmatch '[A-Za-z]' -or $pw -notmatch '\d') {
        Write-Warn 'Password must be >=12 chars and contain a letter + a digit. Try again.'
        continue
    }
    $ADMIN_PASSWORD = $pw
    break
}

Write-Host ''
Write-Note '4/4 - Secrets (auto-generated)'
$JWT_ACCESS_SECRET  = New-Base64Secret
$JWT_REFRESH_SECRET = New-Base64Secret
$MASTER_KEY         = New-HexKey
Write-Ok 'JWT secrets + MASTER_KEY generated'

# ── write .env ────────────────────────────────────────────────────────────
Write-Note 'Writing .env ...'
$DATABASE_URL = "postgresql://taskhub:${POSTGRES_PASSWORD}@postgres:5432/taskhub?schema=public"
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$envBody = @"
# Generated by install.ps1 on $now.

# --- Postgres ---
POSTGRES_USER=taskhub
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=taskhub

# --- Backend ---
NODE_ENV=production
PORT=4000
DATABASE_URL=$DATABASE_URL
REDIS_URL=redis://redis:6379

JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

COOKIE_DOMAIN=
COOKIE_SECURE=$COOKIE_SECURE

CORS_ORIGINS=$CORS_ORIGINS

UPLOAD_MAX_BYTES=10485760
UPLOAD_DIR=/app/uploads

AUTH_RATE_LIMIT_MAX=10
AUTH_RATE_LIMIT_WINDOW=1 minute

# Symmetric at-rest key for LDAP bind passwords, TOTP secrets, webhook
# secrets. Back it up SEPARATELY from Postgres — losing it makes those
# values unrecoverable.
MASTER_KEY=$MASTER_KEY

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
PUBLIC_APP_URL=$PUBLIC_APP_URL

# --- Update check (off by default — opt in to phone GitHub for the latest release) ---
UPDATE_CHECK_ENABLED=false
UPDATE_CHECK_CACHE_HOURS=6

# --- Frontend (build-time) ---
VITE_API_BASE_URL=/api

# --- Caddy ---
SITE_HOST=$SITE_HOST
ACME_EMAIL=$ACME_EMAIL
"@

# Write LF-terminated UTF-8 with no BOM so docker-compose's env parser doesn't
# choke on the leading 0xFEFF that PowerShell 5's default UTF-8 writer adds.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$repoRoot\.env", ($envBody -replace "`r`n", "`n"), $utf8NoBom)
Write-Ok '.env written'

# ── compose ───────────────────────────────────────────────────────────────
Write-Host ''
Write-Note 'Building images and starting the stack - this can take 1-3 minutes...'
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Err 'docker compose up failed.'; exit 1 }

# Poll the backend's /health endpoint for up to ~120 s.
Write-Host ''
Write-Note 'Waiting for backend to become healthy...'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    docker compose exec -T backend wget -qO- http://127.0.0.1:4000/health 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Write-Err 'Backend did not become healthy in ~120 s.'
    Write-Err 'Check: docker compose logs backend'
    exit 1
}
Write-Ok 'Backend is up'

# ── seed ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Note 'Seeding the database with the chosen admin credentials...'
docker compose exec -T `
    -e "SEED_ADMIN_EMAIL=$ADMIN_EMAIL" `
    -e "SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD" `
    backend npx prisma db seed
if ($LASTEXITCODE -ne 0) { Write-Err 'Seed failed.'; exit 1 }
Write-Ok 'Seed complete'

# ── finale ────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '+----------------------------------------------------+' -ForegroundColor Green
Write-Host '|  TaskHub is ready.                                 |' -ForegroundColor Green
Write-Host '+----------------------------------------------------+' -ForegroundColor Green
Write-Host ''
if ($SITE_HOST.StartsWith(':')) {
    Write-Host "  URL:      http://localhost$SITE_HOST/"
} else {
    Write-Host "  URL:      https://$SITE_HOST/"
}
Write-Host "  Email:    $ADMIN_EMAIL"
if ($ADMIN_GENERATED) {
    Write-Host "  Password: $ADMIN_PASSWORD  " -NoNewline
    Write-Host '(generated - copy it now)' -ForegroundColor Yellow
} else {
    Write-Host '  Password: (the value you entered)'
}
Write-Host ''
Write-Host '  Demo team also created with three members @taskhub.local /'
Write-Host "  password 'demo1234'. Delete them from Admin -> Users once you've"
Write-Host '  added your real teammates.'
Write-Host ''
Write-Host '  Next steps:'
Write-Host '    - Sign in and change the admin password under Settings -> Security.'
Write-Host '    - Enable optional features in .env (SMTP, schedulers): see INSTALL.md.'
Write-Host '    - Set up backups: see BACKUP.md.'
