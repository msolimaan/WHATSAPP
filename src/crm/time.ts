// Time-zone helpers using only Intl (no dependencies).

function zoneParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** Milliseconds the zone is ahead of UTC at a given instant (negative for the Americas). */
function offsetMs(ms: number, timeZone: string): number {
  const p = zoneParts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of hh:00 on the local calendar day containing `nowMs`. */
export function localDayAt(nowMs: number, hour: number, timeZone: string, addDays = 0): Date {
  const p = zoneParts(nowMs, timeZone);
  const guess = Date.UTC(p.y, p.m - 1, p.d + addDays, hour);
  // Two passes handle a daylight-saving change between the guess and the answer.
  let t = guess - offsetMs(guess, timeZone);
  t = guess - offsetMs(t, timeZone);
  return new Date(t);
}

/** "01 Oct 2026", the date style your cards use. */
export function cardDate(ms: number, timeZone: string): string {
  // Newer ICU writes "Sept"; the cards use "Sep".
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "short", year: "numeric" })
    .format(new Date(ms))
    .replace("Sept", "Sep");
}

/**
 * Reads a time you'd type: "2026-10-02 09:30" or "2026-10-02T09:30" in your time zone,
 * or any ISO time with an offset ("…Z", "…-03:00"). Returns ms, or NaN if unreadable.
 */
export function parseLocalTime(input: string, timeZone: string): number {
  const s = input.trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return Number.NaN;
  const [, y, mo, d, h = "9", mi = "0"] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  let t = guess - offsetMs(guess, timeZone);
  t = guess - offsetMs(t, timeZone);
  return t;
}
