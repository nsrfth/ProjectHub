import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

// v1.30.7 (S-11): SSRF guard for webhook URLs.
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
// alternate IP encodings) rather than per-prefix matching. The guard is
// applied at TWO points:
//
//   1. create / update — resolve the host once, reject immediately so
//      admins get fast feedback if they typo'd or pointed at the wrong
//      service.
//   2. delivery (deliverOnce + testSend) — resolve AGAIN right before
//      sending. This is the security-critical check: it defends against
//      DNS rebinding, where an attacker registers `evil.example.com`
//      that resolves to a public IP at create time and a private one a
//      few seconds later. Re-resolving at delivery means the rebound
//      response can't sneak through.
//
// Escape hatch: WEBHOOK_ALLOWED_HOSTS is a comma-separated list of host
// strings (lowercased) that are exempt from the guard. Default empty.
// Used for deliberate internal receivers an operator trusts (a
// monitoring sidecar on the same VM, etc.) — and for the test suite,
// whose stub HTTP server lives on 127.0.0.1.

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

export interface SsrfGuardOptions {
  // Comma-separated env value. Hostnames are lower-cased and matched
  // exactly (no subdomain wildcards) — operators should list each
  // intentional internal target explicitly. Empty by default.
  allowedHosts: readonly string[];
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

export class SsrfBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SsrfBlockedError';
  }
}

// Validates a webhook URL and resolves its host. Throws SsrfBlockedError
// when the URL is unsafe. Returns the URL parsed into its components for
// downstream use (the caller can hand it to fetch() unchanged; the
// resolved IP is informational only — at delivery time the IP is
// re-resolved by fetch itself, which is why we re-call this guard right
// before the fetch).
export async function assertWebhookUrlSafe(
  rawUrl: string,
  opts: SsrfGuardOptions,
): Promise<void> {
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

  // Explicit allow-list bypass. Matches the hostname literally.
  if (opts.allowedHosts.includes(host)) return;

  // If the host is already an IP literal, check it directly without DNS.
  if (ipaddr.isValid(host)) {
    if (isAddressInternal(host)) {
      throw new SsrfBlockedError(
        `Webhook target ${host} is in a private / loopback / link-local range`,
      );
    }
    return;
  }

  // Resolve the hostname. We want ALL records — if ANY of them is
  // internal, refuse. This handles dual-stack hosts where one record is
  // public and another points at a private interface.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new SsrfBlockedError(`Could not resolve webhook host ${host}: ${(err as Error).message}`);
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(`DNS resolved no addresses for ${host}`);
  }
  for (const a of addrs) {
    if (isAddressInternal(a.address)) {
      throw new SsrfBlockedError(
        `Webhook target ${host} resolves to ${a.address} (private / loopback / link-local)`,
      );
    }
  }
}

// Test-only export so the regression suite can drive the IP-range
// classifier without spinning up DNS.
export const _internal = { isAddressInternal };
