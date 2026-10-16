/** Application time; operational timers (locks, heartbeats) keep using the real clock. */
export function now(env: NodeJS.ProcessEnv = process.env): Date {
  const value = env['GOTCHEA_NOW'];
  if (value === undefined) return new Date();
  const input = value.trim();
  // Require an unambiguous ISO date or a zoned timestamp, rather than Date's locale parsing.
  const iso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/;
  const ms = /^-?\d+$/.test(input) ? Number(input) : iso.test(input) ? Date.parse(input) : Number.NaN;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) throw new Error('GOTCHEA_NOW must be an ISO date or epoch milliseconds');
  return date;
}
