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
//   - v1.30.9 (S-10) hardened further:
//       - In-memory concurrent-upgrade mutex (409 while in flight).
//       - Optional UPDATER_TARGET_REF pins the checkout to a specific
//         git ref (tag / SHA / branch) instead of tracking origin/main.
//       - Optional UPDATER_REQUIRE_SIGNED_TAG=true runs `git verify-tag`
//         on the target ref before building; abort if verification fails.
//   - Listens only on 0.0.0.0 inside the compose network. Caddy never
//     proxies /upgrade* through to it.
//   - Opt-in: gated by `profiles: ['upgrade']` in docker-compose.yml.
//     Stock installs don't run this container.
//
// Endpoints:
//   GET  /status   — last run timestamp + log tail + in-flight flag
//   POST /upgrade  — fire-and-forget upgrade; returns 202 + startedAt,
//                    or 409 while a previous upgrade is still running.
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

// v1.30.9 (S-10): build the shell command for an upgrade. Extracted as a
// pure function so the unit test can assert on the command string without
// having to spawn a real shell or hit git.
//
//   opts.targetRef         — UPDATER_TARGET_REF (string, optional). When
//                            set, pin the checkout to this exact ref
//                            (tag like v1.30.0, SHA, branch). When unset,
//                            preserve the legacy behaviour of tracking
//                            origin/main via `git pull --ff-only`.
//   opts.requireSignedTag  — UPDATER_REQUIRE_SIGNED_TAG === 'true'. When
//                            on, insert a `git verify-tag` step before
//                            building. The whole chain short-circuits on
//                            the first failure (via && between steps), so
//                            an unsigned / forged tag aborts the upgrade
//                            without rebuilding.
//
// All paths end with `docker compose up -d --build` so the same final
// step rebuilds the image once the working tree is at the chosen ref.
function buildUpgradeCommand(opts = {}) {
  const targetRef = (opts.targetRef || '').trim();
  const requireSignedTag = opts.requireSignedTag === true;

  if (!targetRef) {
    // Legacy: track origin/main.
    return [
      'cd /repo',
      'git fetch origin --tags',
      'git pull --ff-only origin main',
      'docker compose up -d --build',
    ].join(' && ');
  }

  // Pinned ref. We always fetch first so a fresh tag becomes visible;
  // then checkout to a detached HEAD on the pinned ref so the working
  // tree shows the exact code we're about to build.
  const verify = requireSignedTag
    ? `git verify-tag '${shellEscape(targetRef)}'`
    : null;
  const parts = [
    'cd /repo',
    'git fetch origin --tags',
    ...(verify ? [verify] : []),
    `git checkout '${shellEscape(targetRef)}'`,
    'docker compose up -d --build',
  ];
  return parts.join(' && ');
}

// Tiny shell-escape for refs we already trust (env-controlled, set by the
// operator). Wraps in single quotes and escapes embedded single quotes —
// the classic 'foo'\''bar' pattern. Belt-and-suspenders against an
// accidentally-quoted ref like `v1.30.0' && rm -rf /`.
function shellEscape(s) {
  return String(s).replace(/'/g, "'\\''");
}

function createServer(authCheck, opts = {}) {
  const targetRef = opts.targetRef ?? process.env.UPDATER_TARGET_REF ?? '';
  const requireSignedTag =
    opts.requireSignedTag ?? process.env.UPDATER_REQUIRE_SIGNED_TAG === 'true';

  let lastRun = null;
  // v1.30.9 (S-10): in-memory concurrent-upgrade mutex. A second POST
  // /upgrade while one is still running returns 409. Cleared when the
  // spawned process exits (success or failure). The updater is a single
  // Node process, so this in-process flag is sufficient — there's no
  // multi-instance updater to coordinate.
  let inFlight = false;
  // Test-only hook to override spawn() — passing a fake spawner lets the
  // mutex test exercise the close-then-clear path without actually
  // running `docker compose up`.
  const spawner = opts.spawn ?? spawn;

  const server = http.createServer((req, res) => {
    function send(code, body) {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }

    if (req.method === 'GET' && req.url === '/status') {
      send(200, { lastRun, logTail: tailLog(4096), inFlight });
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

      // v1.30.9 (S-10): mutex. Reject a second upgrade while one is in
      // flight. Avoids interleaved log writes + a race where two `docker
      // compose up -d --build` invocations both try to rebuild the same
      // image.
      if (inFlight) {
        send(409, { error: 'upgrade already in flight' });
        return;
      }

      const cmd = buildUpgradeCommand({ targetRef, requireSignedTag });
      const logFd = fs.openSync(LOG_PATH, 'a');
      fs.writeSync(
        logFd,
        `\n\n=== upgrade started ${new Date().toISOString()} ===\n` +
          (targetRef ? `target ref: ${targetRef}\n` : '') +
          (requireSignedTag ? 'requires signed tag\n' : ''),
      );
      const proc = spawner('sh', ['-c', cmd], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      inFlight = true;
      const clearFlag = () => {
        inFlight = false;
      };
      proc.once('close', clearFlag);
      // `error` fires when the binary couldn't even start (rare). Cover
      // it explicitly so a spawn failure doesn't leave inFlight stuck on.
      proc.once('error', clearFlag);
      proc.unref();

      lastRun = new Date().toISOString();
      send(202, {
        status: 'started',
        startedAt: lastRun,
        targetRef: targetRef || null,
      });
      return;
    }

    send(404, { error: 'not found' });
  });
  return server;
}

// Exported for unit tests. The CLI entrypoint below only runs when this
// file is executed directly (require.main === module).
module.exports = { makeAuthCheck, createServer, buildUpgradeCommand };

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
