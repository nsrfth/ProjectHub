// Hardcoded upstream. Forks that want a different "check for updates" target
// should edit this constant — keeping it in code (not env) means a stock
// install always points at the canonical repo and there's no way to spoof
// the check by editing .env.
const GITHUB_REPO = 'nsrfth/taskhub';
const GITHUB_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

// In-memory cache. A single tab refreshing the About page would otherwise
// hammer GitHub's unauthenticated 60-req/hr/IP limit. The cache is process-local
// (no Redis) because the answer is identical for everyone and a single replica
// is the default deployment shape.
interface CacheEntry {
  fetchedAt: number;       // epoch ms
  latestVersion: string | null;   // null when GitHub didn't return a usable tag
  releaseUrl: string | null;
  publishedAt: string | null;
}
let cache: CacheEntry | null = null;
// Single-flight: multiple concurrent admin requests share one fetch.
let inflight: Promise<CacheEntry> | null = null;

export interface UpdateCheckResult {
  // Always present: what we're comparing against. 'dev' when TASKHUB_VERSION
  // isn't injected at deploy time.
  currentVersion: string;
  // Disabled deployments still call the endpoint (the frontend can't know
  // it's off without trying); we return this flag so the UI hides the badge
  // without a confusing error.
  enabled: boolean;
  // Null when the check is disabled, when GitHub is unreachable, or when
  // the latest tag isn't semver-shaped. The UI treats null as "no info".
  latestVersion: string | null;
  // True iff latestVersion > currentVersion. False on equal / older / null.
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  // ISO timestamp of the cached fetch (or null when nothing cached yet).
  // Lets the UI render "checked 12 min ago" without a separate hint.
  checkedAt: string | null;
}

// Strip a leading 'v' and parse `MAJOR.MINOR.PATCH` (optional pre-release
// suffix like `-rc.1` is ignored for ordering — pre-releases are still
// considered older than the same MAJOR.MINOR.PATCH stable). Returns null
// when the string isn't recognisable so callers can fall back gracefully.
export function parseVersion(input: string): [number, number, number] | null {
  if (!input) return null;
  const stripped = input.trim().replace(/^v/i, '');
  // Match the leading numeric triple; anything trailing (build / prerelease)
  // is fine, just doesn't influence the comparison.
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(stripped);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Strict ">" comparison. Returns true iff `latest` is strictly newer than
// `current`. Equal or unknown → false (so "v1.15.0 vs v1.15.0" doesn't
// produce a spurious update badge).
export function isNewer(latest: string | null, current: string): boolean {
  if (!latest) return false;
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false; // equal
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

async function fetchLatestFromGitHub(): Promise<CacheEntry> {
  // 10-second timeout via AbortController — GitHub usually answers in <300 ms;
  // anything longer is a network problem and we don't want admin requests to
  // hang behind it.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(GITHUB_LATEST_URL, {
      headers: {
        // GitHub asks for a User-Agent; their docs say "use your username
        // or app name". Anything stable works.
        'User-Agent': 'TaskHub-update-check',
        Accept: 'application/vnd.github+json',
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      // 404 = repo has no releases yet; 403 = rate-limited. Either way we
      // cache the "no info" answer so we don't retry on every admin click.
      return { fetchedAt: Date.now(), latestVersion: null, releaseUrl: null, publishedAt: null };
    }
    const body = (await res.json()) as GitHubRelease;
    const tag = typeof body.tag_name === 'string' ? body.tag_name : null;
    const html = typeof body.html_url === 'string' ? body.html_url : null;
    const pub = typeof body.published_at === 'string' ? body.published_at : null;
    return { fetchedAt: Date.now(), latestVersion: tag, releaseUrl: html, publishedAt: pub };
  } catch {
    // Network error / abort — same "no info" cache shape.
    return { fetchedAt: Date.now(), latestVersion: null, releaseUrl: null, publishedAt: null };
  } finally {
    clearTimeout(timer);
  }
}

export const updateCheckService = {
  // Hot path for the admin endpoint. Returns the cached answer when fresh;
  // otherwise fires one fetch (single-flight) and caches it.
  //
  // UPDATE_CHECK_ENABLED / _CACHE_HOURS are read directly from process.env on
  // every call (not from the loadEnv() cache) so the operator can toggle the
  // flag with a `docker compose exec backend sh` + env edit + restart, and so
  // tests can flip it between fixtures without rebuilding the app.
  async getStatus(): Promise<UpdateCheckResult> {
    const currentVersion = process.env.TASKHUB_VERSION ?? 'dev';
    const enabled = process.env.UPDATE_CHECK_ENABLED === 'true';

    if (!enabled) {
      return {
        currentVersion,
        enabled: false,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        publishedAt: null,
        checkedAt: null,
      };
    }

    const cacheHoursRaw = Number(process.env.UPDATE_CHECK_CACHE_HOURS ?? 6);
    const cacheHours = Number.isFinite(cacheHoursRaw) && cacheHoursRaw > 0 ? cacheHoursRaw : 6;
    const ttlMs = cacheHours * 60 * 60 * 1000;
    const now = Date.now();
    if (!cache || now - cache.fetchedAt > ttlMs) {
      inflight ??= fetchLatestFromGitHub().finally(() => {
        inflight = null;
      });
      cache = await inflight;
    }

    return {
      currentVersion,
      enabled: true,
      latestVersion: cache.latestVersion,
      updateAvailable: isNewer(cache.latestVersion, currentVersion),
      releaseUrl: cache.releaseUrl,
      publishedAt: cache.publishedAt,
      checkedAt: new Date(cache.fetchedAt).toISOString(),
    };
  },

  // Test helper: clear the cache so a fixture doesn't leak across tests.
  __resetCache(): void {
    cache = null;
    inflight = null;
  },
};
