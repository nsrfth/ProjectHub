import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  makeAuthCheck,
  createServer,
  buildUpgradeCommand,
} = require('../../../updater/server.js');

// v1.30.9 (S-10) regression tests.
//
// Coverage:
//   - concurrent-upgrade mutex: a second /upgrade while one is in flight
//     returns 409; after the in-flight process closes, a new upgrade is
//     accepted.
//   - UPDATER_TARGET_REF pinning: the built command targets the supplied
//     ref instead of `origin/main`.
//   - UPDATER_REQUIRE_SIGNED_TAG opt-in: the built command runs
//     `git verify-tag` before checkout.
//
// We don't shell out to real git for any of this — buildUpgradeCommand
// returns the constructed command STRING, and the mutex test wires a
// fake spawn() that returns an EventEmitter so we control when "the
// upgrade process exits".

const VALID_TOKEN = 'a'.repeat(48);

describe('updater upgrade command builder (S-10)', () => {
  it('default (no ref) tracks origin/main', () => {
    const cmd = buildUpgradeCommand({});
    expect(cmd).toBe(
      'cd /repo && git fetch origin --tags && git pull --ff-only origin main && docker compose up -d --build',
    );
  });

  it('with UPDATER_TARGET_REF, pins the checkout to that ref instead of pulling main', () => {
    const cmd = buildUpgradeCommand({ targetRef: 'v1.30.0' });
    expect(cmd).toContain("git checkout 'v1.30.0'");
    // No `git pull` — pinned refs don't track a moving branch.
    expect(cmd).not.toContain('git pull');
    // Still fetches first so a freshly-pushed tag is visible.
    expect(cmd).toContain('git fetch origin --tags');
    // Still rebuilds at the end.
    expect(cmd).toContain('docker compose up -d --build');
  });

  it('with UPDATER_REQUIRE_SIGNED_TAG=true, prefixes a git verify-tag step', () => {
    const cmd = buildUpgradeCommand({
      targetRef: 'v1.30.0',
      requireSignedTag: true,
    });
    expect(cmd).toContain("git verify-tag 'v1.30.0'");
    // verify-tag MUST run BEFORE checkout — the chain is &&-separated so
    // a failed verification aborts the whole chain.
    const verifyIdx = cmd.indexOf('git verify-tag');
    const checkoutIdx = cmd.indexOf('git checkout');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeGreaterThan(verifyIdx);
  });

  it('signed-tag verification has no effect without a target ref (legacy origin/main path)', () => {
    // The signing requirement only makes sense for a pinned ref. Without
    // a ref we keep legacy behaviour — there's no tag to verify when
    // tracking a branch.
    const cmd = buildUpgradeCommand({ requireSignedTag: true });
    expect(cmd).not.toContain('git verify-tag');
  });

  it('shell-escapes the target ref to defeat injection via env', () => {
    const cmd = buildUpgradeCommand({ targetRef: "v1.0' && rm -rf /" });
    // The malicious closing quote becomes an escaped sequence; the
    // injected `rm` is now part of the ref name string, not a separate
    // command.
    expect(cmd).toContain("'v1.0'\\'' && rm -rf /'");
  });
});

// ── Mutex / 409-while-in-flight ────────────────────────────────────────
//
// We stand up a real http server (createServer returns it), wire a fake
// spawn() that returns an EventEmitter we control, then POST twice and
// assert on the responses.

interface FakeProc extends EventEmitter {
  unref: () => void;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.unref = () => undefined;
  return proc;
}

async function getStatus(port: number): Promise<{ status: number; body: { inFlight?: boolean } }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/status', method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function postUpgrade(port: number, token: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/upgrade',
        method: 'POST',
        headers: { 'x-updater-token': token, 'content-length': '0' },
      },
      (res) => {
        // Drain so the connection closes cleanly.
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('updater concurrent-upgrade mutex (S-10)', () => {
  const servers: import('http').Server[] = [];
  let currentProc: FakeProc | null = null;

  afterEach(async () => {
    currentProc = null;
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  async function startServer(): Promise<number> {
    const fakeSpawn = vi.fn().mockImplementation(() => {
      currentProc = makeFakeProc();
      return currentProc;
    });
    const server = createServer(makeAuthCheck(VALID_TOKEN), { spawn: fakeSpawn });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('listen failed');
    return addr.port;
  }

  it('a second /upgrade while one is in flight returns 409', async () => {
    const port = await startServer();
    const first = await postUpgrade(port, VALID_TOKEN);
    expect(first.status).toBe(202);
    // The in-flight flag is visible via /status.
    const mid = await getStatus(port);
    expect(mid.body.inFlight).toBe(true);

    const second = await postUpgrade(port, VALID_TOKEN);
    expect(second.status).toBe(409);
  });

  it('after the in-flight upgrade closes, a new /upgrade is accepted', async () => {
    const port = await startServer();
    const first = await postUpgrade(port, VALID_TOKEN);
    expect(first.status).toBe(202);
    expect(currentProc).not.toBeNull();

    // Simulate the spawned shell exiting (exit code 0). The server's
    // `close` handler clears the mutex.
    currentProc!.emit('close', 0);
    // Give the next tick a chance — emit is synchronous, so the flag
    // should already be cleared. /status reflects it.
    const after = await getStatus(port);
    expect(after.body.inFlight).toBe(false);

    const second = await postUpgrade(port, VALID_TOKEN);
    expect(second.status).toBe(202);
  });

  it('a spawn error also clears the in-flight flag (no stuck mutex)', async () => {
    const port = await startServer();
    await postUpgrade(port, VALID_TOKEN);
    expect(currentProc).not.toBeNull();
    // Spawned binary fails to start (rare in prod, but cover the path).
    currentProc!.emit('error', new Error('spawn failed'));
    const after = await getStatus(port);
    expect(after.body.inFlight).toBe(false);
  });

  it('an unauthenticated /upgrade does NOT acquire the mutex', async () => {
    const port = await startServer();
    // Hitting /upgrade without the right token must 401 BEFORE the
    // in-flight flag is set — otherwise an attacker could brick the
    // sidecar with a single bad POST.
    const bad = await postUpgrade(port, 'wrong-token-also-24-chars-long');
    expect(bad.status).toBe(401);
    const status = await getStatus(port);
    expect(status.body.inFlight).toBe(false);
    // A legit upgrade after the failed attempt still works.
    const ok = await postUpgrade(port, VALID_TOKEN);
    expect(ok.status).toBe(202);
  });
});
