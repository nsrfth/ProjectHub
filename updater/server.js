// taskhub-updater (v1.22) — privileged sidecar that runs `git pull + docker
// compose up -d --build` on the host when poked. Mounted with the host
// docker socket AND the repo directory, so it must NEVER be exposed outside
// the compose network. The backend reaches it via the internal hostname
// `updater:9000`; the listening port is not published to the host.
//
// Security model:
//   - This container holds the docker socket — owning it = owning the host.
//   - The only authentication is a shared token (UPDATER_TOKEN), checked
//     against the X-Updater-Token header. v1.30.2 (S-1) hardened: the
//     server REFUSES TO START when UPDATER_TOKEN is unset or < 24 chars,
//     and the header comparison is constant-time via crypto.timingSafeEqual.
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
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = parseInt(process.env.UPDATER_PORT || '9000', 10);
const LOG_PATH = '/tmp/upgrade.log';
const MIN_TOKEN_LEN = 24;

// v1.30.2 (S-1): build the auth check eagerly so we can fail at startup if
// the token is misconfigured. The closure caches the expected-token buffer
// so the per-request path skips an allocation. Exported for tests.
function makeAuthCheck(token) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LEN) {
    throw new Error(
      `UPDATER_TOKEN must be set and at least ${MIN_TOKEN_LEN} characters. ` +
        'Generate one with: openssl rand -base64 48',
    );
  }
  const expected = Buffer.from(token, 'utf8');
  return function check(header) {
    if (typeof header !== 'string' || header.length === 0) return false;
    const got = Buffer.from(header, 'utf8');
    // crypto.timingSafeEqual throws on length mismatch. Constant-time-compare
    // a fixed-length zero buffer of `expected.length` so the timing of the
    // length check is independent of the supplied header length.
    if (got.length !== expected.length) {
      crypto.timingSafeEqual(expected, expected);
      return false;
    }
    return crypto.timingSafeEqual(got, expected);
  };
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

function createServer(authCheck) {
  let lastRun = null;
  const server = http.createServer((req, res) => {
    function send(code, body) {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }

    if (req.method === 'GET' && req.url === '/status') {
      send(200, { lastRun, logTail: tailLog(4096) });
      return;
    }

    if (req.method === 'POST' && req.url === '/upgrade') {
      // v1.30.2 (S-1): unconditional constant-time check. The previous
      // `if (TOKEN && header !== TOKEN)` short-circuited to "allow" when
      // TOKEN was empty — a misconfiguration that let any caller on the
      // compose network trigger an upgrade.
      if (!authCheck(req.headers['x-updater-token'])) {
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
  return server;
}

// Exported for unit tests. The CLI entrypoint below only runs when this
// file is executed directly (require.main === module).
module.exports = { makeAuthCheck, createServer };

if (require.main === module) {
  let authCheck;
  try {
    authCheck = makeAuthCheck(process.env.UPDATER_TOKEN || '');
  } catch (err) {
    // Hard refuse. The sidecar holds the docker socket — running without a
    // valid token means "any caller on the compose network can take over
    // the host". Previously this was a console.warn-and-proceed.
    console.error('[updater] FATAL:', err.message);
    process.exit(1);
  }
  const server = createServer(authCheck);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[updater] listening on :${PORT}`);
  });
}
