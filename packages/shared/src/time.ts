import { DEFAULT_TIMEZONE } from './constants';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

export function toZonedParts(date: Date, timeZone: string = DEFAULT_TIMEZONE): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const p = toZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/** Converts a wall-clock time in `timeZone` to a UTC instant. */
export function fromZoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass handles DST edges for zones that have them (Africa/Lagos does not).
  result = guess - tzOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

/**
 * Moves an instant into the allowed local sending window [startHour, endHour).
 * Before the window -> same local day at startHour. At/after the window -> next local day at startHour.
 */
export function adjustToSendingWindow(
  date: Date,
  startHour: number,
  endHour: number,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  const p = toZonedParts(date, timeZone);
  if (p.hour >= startHour && p.hour < endHour) return date;
  if (p.hour < startHour) return fromZoned(p.year, p.month, p.day, startHour, 0, timeZone);
  const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day) + 24 * 3600 * 1000);
  return fromZoned(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    startHour,
    0,
    timeZone,
  );
}

export function isWithinSendingWindow(
  date: Date,
  startHour: number,
  endHour: number,
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  const h = toZonedParts(date, timeZone).hour;
  return h >= startHour && h < endHour;
}

/** Start of the local day containing `date`, as a UTC instant. */
export function startOfZonedDay(date: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const p = toZonedParts(date, timeZone);
  return fromZoned(p.year, p.month, p.day, 0, 0, timeZone);
}

export function formatDateTime(
  date: Date | string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-NG', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export function formatDate(
  date: Date | string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-NG', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}
