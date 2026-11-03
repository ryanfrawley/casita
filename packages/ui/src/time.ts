// The content rules for time, in one place.

type TimeValue = Date | number | string;
export type TimeFormat = "relative" | "clock" | "date" | "datetime";

export const DAY = 864e5;
export const HOUR = 36e5;

/** "7:42 PM" → "7:42 pm" */
const lower = (text: string): string =>
  text.replace(/\s?([AP]M)/, (_, half: string) => ` ${half.toLowerCase()}`);

/** "7:42 pm" */
export const formatClock = (t: number): string =>
  lower(new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));

/** "Sun, Oct 4, 11:45 am" */
export function formatWhen(t: number): string {
  const d = new Date(t);
  const day = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${formatClock(t)}`;
}

/** An axis label for a tick at `t` when ticks are `step` apart: "6 am", "12:30 pm", "Mon 5". */
export function formatTick(t: number, step: number): string {
  const d = new Date(t);
  if (step >= DAY || (d.getHours() === 0 && d.getMinutes() === 0)) {
    return d.toLocaleDateString([], { weekday: "short", day: "numeric" });
  }
  return lower(
    d.toLocaleTimeString([], {
      hour: "numeric",
      minute: d.getMinutes() ? "2-digit" : undefined,
    }),
  );
}

/** "12 min", "1h 6m", "2d 3h" */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 6e4);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours}h${rest ? ` ${rest}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const toDate = (value: TimeValue): Date =>
  value instanceof Date
    ? value
    : new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function dateWord(d: Date, now: Date): string {
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const year = now.getFullYear() !== d.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${weekday} ${d.getDate()} ${month}${year}`;
}

/** "just now", "4 min ago", "at 10:42 pm", "yesterday at 9:15 pm", "Mon 3 Oct". */
export function formatTime(
  value: TimeValue,
  options: { format?: TimeFormat; now?: TimeValue } = {},
): string {
  const d = toDate(value);
  const now = options.now != null ? toDate(options.now) : new Date();
  if (Number.isNaN(d.getTime())) return "—";
  if (options.format === "clock") return formatClock(d.getTime());
  if (options.format === "date") return dateWord(d, now);
  if (options.format === "datetime") return formatWhen(d.getTime());
  const diff = now.getTime() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  if (abs < 45e3) return future ? "in a moment" : "just now";
  if (abs < HOUR) {
    const minutes = Math.max(1, Math.round(abs / 6e4));
    return future ? `in ${minutes} min` : `${minutes} min ago`;
  }
  if (abs < DAY) {
    if (sameDay(d, now)) return `at ${formatClock(d.getTime())}`;
    const next = new Date(now.getTime());
    next.setDate(next.getDate() + (future ? 1 : -1));
    if (sameDay(d, next)) {
      return `${future ? "tomorrow" : "yesterday"} at ${formatClock(d.getTime())}`;
    }
  }
  return dateWord(d, now);
}
