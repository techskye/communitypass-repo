import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Formats integer kobo as NGN for display. */
export function formatNgn(kobo: number): string {
  const naira = kobo / 100;
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: kobo % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(naira);
}

/** Converts a naira amount (possibly with kobo decimals) to integer kobo, rejecting fractions of a kobo. */
export function nairaToKobo(naira: number): number {
  const kobo = Math.round(naira * 100);
  if (Math.abs(kobo - naira * 100) > 1e-6) throw new Error('Amount has more than 2 decimal places');
  return kobo;
}

/**
 * Normalizes a phone number to E.164. Defaults to Nigeria for national-format input
 * (e.g. 0803 123 4567 -> +2348031234567). Returns null for invalid numbers.
 */
export function normalizePhoneE164(input: string, defaultCountry: 'NG' = 'NG'): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  if (e164.length <= 6) return e164;
  return `${e164.slice(0, 4)}•••${e164.slice(-4)}`;
}

/**
 * Escapes a cell for CSV export and neutralizes spreadsheet formula injection
 * (cells starting with = + - @ TAB CR are prefixed with a single quote).
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const r of rows) lines.push(r.map(escapeCsvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
