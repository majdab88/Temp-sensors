// Every date the app shows is day-first (dd/mm/yyyy, 24 h), whatever the
// phone's locale — the same rule the web dashboard enforces with en-GB.
// Formatting is done by hand rather than with toLocaleString: Hermes on
// Android ships without full Intl data, so a locale argument is not reliable.

type DateIn = Date | string | number | null | undefined;

function toDate(input: DateIn): Date | null {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** dd/mm/yyyy */
export function formatDate(input: DateIn): string {
  const d = toDate(input);
  return d ? `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}` : '';
}

/** dd/mm/yyyy, HH:MM:SS */
export function formatDateTime(input: DateIn): string {
  const d = toDate(input);
  return d ? `${formatDate(d)}, ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : '';
}

/** dd/mm/yyyy HH:MM */
export function formatDateTimeShort(input: DateIn): string {
  const d = toDate(input);
  return d ? `${formatDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : '';
}

/** "27 Nov 14:05" — compact, still day-first. */
export function formatDayMonthTime(input: DateIn): string {
  const d = toDate(input);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}` : '—';
}

export function formatTime(input: DateIn): string {
  const d = toDate(input);
  return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : '';
}

/** Compact relative time: "just now", "4 min ago", "3 h ago", "2 d ago". */
export function timeAgo(input: DateIn): string {
  const d = toDate(input);
  if (!d) return 'no data';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} d ago`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Relative within the last day, absolute (day-first) after. */
export function smartTime(input: DateIn): string {
  const d = toDate(input);
  if (!d) return '';
  return Date.now() - d.getTime() < 86400000 ? timeAgo(d) : formatDayMonthTime(d);
}

export function formatDuration(sec: number | string | null | undefined): string {
  if (sec == null) return '—';
  const m = Math.round(Number(sec) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Start of a local calendar day. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export { MONTHS };
