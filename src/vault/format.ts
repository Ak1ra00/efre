/** Dates in the vault UI. Times are Unix seconds (docs/IPC.md); `nowMs` is Date.now(). */

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const narrowRelativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "always", style: "narrow" });

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatDate(unixSeconds: number): string {
  return dateFormat.format(new Date(unixSeconds * 1000));
}

export function formatDateTime(unixSeconds: number): string {
  return dateTimeFormat.format(new Date(unixSeconds * 1000));
}

/** ISO 8601 for <time dateTime>. */
export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function relativeParts(unixSeconds: number, nowMs: number): [number, Intl.RelativeTimeFormatUnit] {
  const delta = unixSeconds - Math.floor(nowMs / 1000);
  const abs = Math.abs(delta);
  if (abs < MINUTE) return [0, "second"];
  if (abs < HOUR) return [Math.round(delta / MINUTE), "minute"];
  if (abs < DAY) return [Math.round(delta / HOUR), "hour"];
  if (abs < MONTH) return [Math.round(delta / DAY), "day"];
  if (abs < YEAR) return [Math.round(delta / MONTH), "month"];
  return [Math.round(delta / YEAR), "year"];
}

/** "just now", "5 minutes ago", "yesterday", "3 months ago". */
export function formatRelative(unixSeconds: number, nowMs: number): string {
  const [value, unit] = relativeParts(unixSeconds, nowMs);
  if (unit === "second") return "just now";
  return relativeFormat.format(value, unit);
}

/** Compact form for list rows: "5m ago", "3d ago". */
export function formatRelativeShort(unixSeconds: number, nowMs: number): string {
  const [value, unit] = relativeParts(unixSeconds, nowMs);
  if (unit === "second") return "now";
  return narrowRelativeFormat.format(value, unit);
}
