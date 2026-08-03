import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

// v1.30.7 (S-11): SSRF guard for webhook URLs.
// v2.23.3 (S-11b): DNS-rebinding fix — validation now PINS the address.
//
// Webhooks let a user with `webhooks.manage` POST to an arbitrary URL on
// every event in their team. Without an SSRF check that lets the same
// user point the backend at:
//   - localhost / 127.0.0.1 / ::1 (any service co-tenant on the host)
//   - 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 (RFC 1918 internal)
//   - 169.254.169.254 (cloud metadata; AWS / GCP / Azure all serve there)
//   - the compose-network internal updater sidecar
//   - IPv4-mapped IPv6 forms of the above (::ffff:127.0.0.1)
//
// We rely on ipaddr.js's `range()` resolver (a maintained library; hand-
// rolled SSRF checks are notoriously buggy around IPv4-mapped IPv6 and
// alternate IP encodings) rather than per-prefix matching.
//
// THE REBINDING PROBLEM (fixed in v2.23.3). Up to v2.23.2 the guard
// resolved the hostname, validated the answers, and then handed the
// *URL* to fetch() — which resolved the hostname a SECOND time. An
// attacker controlling the authoritative DNS server for their own name
// answers "public" for the guard's query and "127.0.0.1" (or
// 169.254.169.254, or an RFC1918 host) for the connection's query. The
// guard passes; the socket lands inside the perimeter.
//
// The fix: resolution happens ONCE, in `resolveSafeTarget`, which
// returns the validated IP alongside the parsed URL. Delivery connects
// to THAT ADDRESS via a per-request pinned DNS lookup (lib/pinnedHttp.ts)
// and never asks the resolver again. The original hostname is still used
// for the Host header and the TLS SNI / certificate check, so pinning
// costs nothing in correctness and TLS validation is untouched.
//
// Guard points:
//   1. create / update — reject immediately so admins get fast feedback
//      if they typo'd or pointed at the wrong service.
//   2. delivery (deliverOnce + testSend) — resolve + validate + PIN
//      right before sending. This is the security-critical one.
//
// Escape hatch: WEBHOOK_ALLOWED_HOSTS is a comma-separated list of host
// strings (lowercased) that are exempt from the range policy. Default
// empty. Used for deliberate internal receivers an operator trusts (a
// monitoring sidecar on the same VM, etc.) — and for the test suite,
// whose stub HTTP server lives on 127.0.0.1. Allow-listed hosts are
// still pinned: they resolve once and connect to that answer.

// ipaddr.js classifies an address into named ranges. These are the
// ranges we treat as INTERNAL — any of them is a refusal. The library
// returns a string label per address; we check membership in this set.
// References:
//   - IPv4 ranges: https://github.com/whitequark/ipaddr.js#address-types
//   - IPv6 ranges: same
const BLOCKED_RANGES = new Set<string>([
  // IPv4
  'unspecified', // 0.0.0.0/8
  'broadcast', // 255.255.255.255
  'multicast', // 224.0.0.0/4 — not strictly SSRF but never a legitimate webhook
  'linkLocal', // 169.254.0.0/16 — INCLUDES 169.254.169.254 cloud metadata
  'loopback', // 127.0.0.0/8
  'carrierGradeNat', // 100.64.0.0/10
  'private', // 10/8, 172.16/12, 192.168/16
  'reserved', // 240.0.0.0/4
  // IPv6
  'unspecifiedV6', // ::
  'linkLocalV6', // fe80::/10
  'loopbackV6', // ::1
  'uniqueLocal', // fc00::/7
  // IPv4-mapped IPv6 (::ffff:0:0/96) — ipaddr.js classifies these as
  // 'ipv4Mapped'; we recover the underlying IPv4 and re-check that.
]);

// One DNS answer. Deliberately the shape `dns.lookup(h, {all:true})`
// returns so the production resolver drops in unchanged and tests can
// substitute a deterministic (rebinding!) stub.
export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SsrfGuardOptions {
  // Comma-separated env value. Hostnames are lower-cased and matched
  // exactly (no subdomain wildcards) — operators should list each
  // intentional internal target explicitly. Empty by default.
  allowedHosts: readonly string[];
  // Injectable resolver. Defaults to node's `dns.lookup(all:true)`.
  // Tests drive rebinding scenarios through this seam; production never
  // sets it.
  resolve?: AddressResolver;
}

// The result of a successful guard pass: everything the transport needs
// to connect WITHOUT resolving the hostname again.
export interface PinnedTarget {
  url: URL;
  // The hostname exactly as written in the URL — Host header + TLS SNI.
  hostname: string;
  port: number;
  // The single validated IP the socket must connect to.
  address: string;
  family: 4 | 6;
  // True when the host matched WEBHOOK_ALLOWED_HOSTS and the range
  // policy was intentionally bypassed. Surfaced for logging/tests.
  allowListed: boolean;
}

export function parseAllowedHosts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function isAddressInternal(addr: string): boolean {
  let parsed;
  try {
    parsed = ipaddr.parse(addr);
  } catch {
    // Unparseable -> treat as suspicious, refuse.
    return true;
  }
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — recover the IPv4 and
  // re-check. ipaddr.js's `toIPv4Address()` only exists on the IPv6
  // class for ipv4Mapped addresses.
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      const v4 = v6.toIPv4Address();
      return isAddressInternal(v4.toString());
    }
  }
  const range = parsed.range();
  return BLOCKED_RANGES.has(range);
}

// 4 or 6, derived from the literal rather than trusted from the
// resolver — a stub (or a resolver returning family:0) must not be able
// to talk us into the wrong socket family.
function familyOf(address: string): 4 | 6 {
  try {
    return ipaddr.parse(address).kind() === 'ipv6' ? 6 : 4;
  } catch {
    return 4;
  }
}

export class SsrfBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SsrfBlockedError';
  }
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true });
}

function defaultPortFor(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

// Validate a webhook URL AND pin the address the caller must connect to.
//
// Every resolved address is checked against the range policy: if ANY of
// them is internal the whole target is refused (a dual-stack host with
// one public and one private record is exactly the shape an attacker
// wants). The address returned is one of the addresses that was
// validated — the transport connects to it directly, so there is no
// second resolution for an attacker's DNS server to answer differently.
export async function resolveSafeTarget(
  rawUrl: string,
  opts: SsrfGuardOptions,
): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Webhook URL is not a valid URL');
  }

  // Scheme allow-list. http + https only; never file://, gopher://, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Webhook URL scheme must be http or https, got ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) throw new SsrfBlockedError('Webhook URL has no host');

  const port = defaultPortFor(url);
  const allowListed = opts.allowedHosts.includes(host);
  const resolver = opts.resolve ?? defaultResolve;

  // If the host is already an IP literal there is nothing to resolve —
  // check it directly and pin it.
  if (ipaddr.isValid(host)) {
    if (!allowListed && isAddressInternal(host)) {
      throw new SsrfBlockedError(
        `Webhook target ${host} is in a private / loopback / link-local range`,
      );
    }
    return { url, hostname: host, port, address: host, family: familyOf(host), allowListed };
  }

  let addrs: ResolvedAddress[];
  try {
    addrs = await resolver(host);
  } catch (err) {
    throw new SsrfBlockedError(`Could not resolve webhook host ${host}: ${(err as Error).message}`);
  }
  if (!addrs || addrs.length === 0) {
    throw new SsrfBlockedError(`DNS resolved no addresses for ${host}`);
  }

  // Allow-listed hosts skip the range policy (that is the whole point of
  // the escape hatch) but are still PINNED to the answer we just saw —
  // an allow-listed name must not become a rebinding vector either.
  if (!allowListed) {
    for (const a of addrs) {
      if (isAddressInternal(a.address)) {
        throw new SsrfBlockedError(
          `Webhook target ${host} resolves to ${a.address} (private / loopback / link-local)`,
        );
      }
    }
  }

  const chosen = addrs[0]!;
  return {
    url,
    hostname: host,
    port,
    address: chosen.address,
    family: familyOf(chosen.address),
    allowListed,
  };
}

// Back-compat wrapper for the create/update path, which only cares
// whether the URL is acceptable. Throws SsrfBlockedError when it is not.
export async function assertWebhookUrlSafe(
  rawUrl: string,
  opts: SsrfGuardOptions,
): Promise<void> {
  await resolveSafeTarget(rawUrl, opts);
}

// Test-only export so the regression suite can drive the IP-range
// classifier without spinning up DNS.
export const _internal = { isAddressInternal, familyOf };
