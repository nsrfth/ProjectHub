// taskhub-updater (v1.22) — privileged sidecar that runs `git pull + docker
// compose up -d --build` on the host when poked. Mounted with the host
// docker socket AND the repo directory, so it must NEVER be exposed outside
// the compose network. The backend reaches it via the internal hostname
// `updater:9000`; the listening port is not published to the host.
//
// Security model:
//   - This container holds the docker socket — owning it = owning the host.
//   - The only authentication is a shared token (UPDATER_TOKEN), checked
//     against the X-Updater-Token header. Set a strong token in .env.
//   - Listens only on 0.0.0.0 inside the compose network. Caddy never
//     proxies /upgrade* through to it.
//   - Opt-in: gated by `profiles: ['upgrade']` in docker-compose.yml.
//     Stock installs don't run this container.
//
// Endpoints:
//   GET  /status   — last run timestamp + log tail
//   POST /upgrade  — fire-and-forget upgrade; returns 202 + startedAt
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = parseInt(process.env.UPDATER_PORT || '9000', 10);
const TOKEN = process.env.UPDATER_TOKEN || '';
const LOG_PATH = '/tmp/upgrade.log';

let lastRun = null;

if (!TOKEN) {
  console.warn('[updater] WARNING: UPDATER_TOKEN unset. Any caller on the compose network can trigger an upgrade.');
}

function tailLog(maxBytes) {
  try {
    const buf = fs.readFileSync(LOG_PATH);
    if (buf.length <= maxBytes) return buf.toString('utf8');
    return buf.slice(buf.length - maxBytes).toString('utf8');
  } catch {
    return '';
  }
}

const server = http.createServer((req, res) => {
  // Tiny JSON helper; the surface is small enough that a real framework
  // would be overkill.
  function send(code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  if (req.method === 'GET' && req.url === '/status') {
    send(200, { lastRun, logTail: tailLog(4096) });
    return;
  }

  if (req.method === 'POST' && req.url === '/upgrade') {
    if (TOKEN && req.headers['x-updater-token'] !== TOKEN) {
      send(401, { error: 'invalid or missing X-Updater-Token' });
      return;
    }

    // The upgrade command is run via `sh -c` so the chained `git fetch &&
    // docker compose up -d --build` reads naturally. Detached + unref'd so
    // the child survives even after the parent process (this Node server)
    // gets recreated mid-upgrade.
    //
    // Why `git pull origin main` instead of checking out a specific tag:
    // keeps the script tiny + idempotent. Operators who want to pin a tag
    // can SSH in and `git checkout vX.Y.Z` before clicking "Upgrade".
    const cmd = 'cd /repo && git fetch origin --tags && git pull --ff-only origin main && docker compose up -d --build';
    const logFd = fs.openSync(LOG_PATH, 'a');
    fs.writeSync(logFd, `\n\n=== upgrade started ${new Date().toISOString()} ===\n`);
    const proc = spawn('sh', ['-c', cmd], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    proc.unref();

    lastRun = new Date().toISOString();
    send(202, { status: 'started', startedAt: lastRun });
    return;
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[updater] listening on :${PORT}`);
});
