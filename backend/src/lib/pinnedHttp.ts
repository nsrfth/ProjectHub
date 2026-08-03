import http from 'node:http';
import https from 'node:https';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { PinnedTarget } from './ssrfGuard.js';

// v2.23.3 (S-11b): HTTP transport that connects to a PRE-VALIDATED IP.
//
// The SSRF guard resolves a webhook host and checks every answer against
// the private/loopback/link-local policy. That check is worthless if the
// request then resolves the hostname a second time — an attacker's
// authoritative DNS server simply answers differently on the second
// query (DNS rebinding). `fetch()` gives us no per-request DNS hook
// (Node's global fetch exposes no dispatcher without depending on
// undici directly), so delivery goes through node:http / node:https,
// which DO accept a per-request `lookup`.
//
// The pinning is per request. There is no process-wide DNS override, no
// mutable module state, and no monkey-patching: each call builds its own
// options object with its own closure over one address.
//
// What is deliberately preserved:
//   - Host header: taken from the ORIGINAL hostname (+ non-default
//     port), not the pinned IP, so virtual-hosted receivers still work.
//   - TLS: `servername` is the original hostname, so SNI and the
//     certificate's subject/SAN are checked against the name the admin
//     configured. `rejectUnauthorized` is never touched — full chain
//     validation stays on.
//   - Redirects: node:http does not follow them. A 3xx is reported as a
//     refused redirect so it can never become a request to an internal
//     address.
//   - Timeouts: a single deadline covering connect + response headers.

export interface PinnedRequestInput {
  target: PinnedTarget;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface PinnedResponse {
  status: number;
  // True for any 3xx. The caller treats this as a failed delivery — we
  // never follow the Location, which would escape the guard.
  redirected: boolean;
}

export type PinnedRequester = (input: PinnedRequestInput) => Promise<PinnedResponse>;

// A `dns.lookup`-shaped function that ignores the hostname and always
// answers with the address the SSRF guard validated.
export function pinnedLookup(
  address: string,
  family: 4 | 6,
): (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void {
  return (_hostname, options, callback) => {
    if (options && typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

// The Host header value: bracketed for IPv6 literals, port appended
// only when it isn't the scheme default (matching what agents expect).
export function formatHostHeader(target: PinnedTarget): string {
  const host = target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname;
  const isDefault =
    (target.url.protocol === 'https:' && target.port === 443) ||
    (target.url.protocol === 'http:' && target.port === 80);
  return isDefault ? host : `${host}:${target.port}`;
}

// Exported separately from the request itself so tests can assert the
// security-relevant option shape (pinned lookup, preserved Host + SNI,
// TLS validation left on) without opening a socket.
export function buildPinnedRequestOptions(input: PinnedRequestInput): https.RequestOptions {
  const { target } = input;
  const isHttps = target.url.protocol === 'https:';
  const path = `${target.url.pathname}${target.url.search}`;
  const options: https.RequestOptions = {
    protocol: target.url.protocol,
    // `hostname` stays the ORIGINAL name so node derives the Host header
    // and the TLS servername from it; `lookup` is what decides where the
    // socket actually goes.
    hostname: target.hostname,
    port: target.port,
    path: path || '/',
    method: input.method,
    headers: { ...input.headers, host: formatHostHeader(target) },
    lookup: pinnedLookup(target.address, target.family),
    // No connection pooling: a pooled socket keyed by host:port could be
    // reused across targets that pinned different addresses.
    agent: false,
    timeout: input.timeoutMs,
  };
  if (isHttps) {
    // Explicit rather than implicit: the certificate must match the
    // hostname the admin configured, never the pinned IP.
    options.servername = target.hostname.includes(':') ? undefined : target.hostname;
  }
  return options;
}

// Perform the request. Resolves with the status (never follows a
// redirect); rejects on transport/TLS/timeout errors.
export const sendPinnedRequest: PinnedRequester = (input) =>
  new Promise<PinnedResponse>((resolve, reject) => {
    const options = buildPinnedRequestOptions(input);
    const transport = input.target.url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = transport.request(options, (res) => {
      const status = res.statusCode ?? 0;
      // We never read the body — a webhook receiver's response content is
      // not part of the contract, and draining an attacker-controlled
      // stream is needless exposure. Destroy it so the socket closes.
      res.destroy();
      finish(() => resolve({ status, redirected: status >= 300 && status < 400 }));
    });

    req.setTimeout(input.timeoutMs, () => {
      req.destroy(new Error(`Webhook request timed out after ${input.timeoutMs}ms`));
    });
    req.on('error', (err) => finish(() => reject(err)));
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
