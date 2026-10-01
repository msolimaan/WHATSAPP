// When automatic messages may go out: outside quiet hours and, optionally, not on weekends.

export interface SendWindow {
  /** "20:00-08:30" (may wrap past midnight). */
  quietHours: string;
  skipWeekends: boolean;
  timeZone: string;
}

function local(ms: number, timeZone: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), weekday };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function isQuiet(ms: number, w: SendWindow): boolean {
  const { minutes, weekday } = local(ms, w.timeZone);
  if (w.skipWeekends && (weekday === 0 || weekday === 6)) return true;
  const [start, end] = w.quietHours.split("-").map(toMinutes);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The first moment at or after `ms` when sending is allowed (searched in 5-minute steps, up to 8 days). */
export function nextAllowed(ms: number, w: SendWindow): number {
  if (!isQuiet(ms, w)) return ms;
  const step = 5 * 60 * 1000;
  let t = Math.ceil(ms / step) * step;
  for (let i = 0; i < (8 * 24 * 60) / 5; i++, t += step) if (!isQuiet(t, w)) return t;
  return ms;
}
