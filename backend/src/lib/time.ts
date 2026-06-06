// Parse short duration strings like "15m", "30d", "1h" into milliseconds.
// Used for JWT TTLs and refresh-token expiry.
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const n = Number(match[1]);
  const unit = match[2]!;
  return n * UNIT_MS[unit]!;
}
