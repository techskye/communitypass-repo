import { describe, expect, it } from 'vitest';
import {
  computeNewPaidUntil,
  getEntitlement,
  notificationDedupeKey,
  planReminders,
} from './membership';
import { DAY_MS, DEFAULT_REMINDER_SETTINGS } from './constants';
import { adjustToSendingWindow, toZonedParts } from './time';
import { escapeCsvCell, normalizePhoneE164, toCsv } from './format';

const iso = (s: string) => new Date(s);

describe('computeNewPaidUntil — fixed durations across month/year boundaries (test 13)', () => {
  it('30 days from 31 Jan is 2 Mar (not "one month")', () => {
    expect(computeNewPaidUntil(null, iso('2026-01-31T10:00:00Z'), 30).toISOString()).toBe(
      '2026-03-02T10:00:00.000Z',
    );
  });
  it('30 days from 15 Dec crosses the year boundary exactly', () => {
    expect(computeNewPaidUntil(null, iso('2026-12-15T23:30:00Z'), 30).toISOString()).toBe(
      '2027-01-14T23:30:00.000Z',
    );
  });
  it('365 days across a leap year lands on 29 Feb', () => {
    expect(computeNewPaidUntil(null, iso('2027-03-01T00:00:00Z'), 365).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
  it('7 days across a month end', () => {
    expect(computeNewPaidUntil(null, iso('2026-02-25T12:00:00Z'), 7).toISOString()).toBe(
      '2026-03-04T12:00:00.000Z',
    );
  });
  it('90 days is exactly 90 * 24h', () => {
    const start = iso('2026-11-30T05:00:00Z');
    expect(computeNewPaidUntil(null, start, 90).getTime() - start.getTime()).toBe(90 * DAY_MS);
  });
});

describe('computeNewPaidUntil — renewal rules', () => {
  it('early renewal preserves remaining time', () => {
    const current = iso('2026-05-20T00:00:00Z');
    const paidAt = iso('2026-05-10T00:00:00Z');
    expect(computeNewPaidUntil(current, paidAt, 30).toISOString()).toBe('2026-06-19T00:00:00.000Z');
  });
  it('expired renewal starts from verified payment time', () => {
    const current = iso('2026-04-01T00:00:00Z');
    const paidAt = iso('2026-05-10T08:00:00Z');
    expect(computeNewPaidUntil(current, paidAt, 7).toISOString()).toBe('2026-05-17T08:00:00.000Z');
  });
  it('rejects invalid durations', () => {
    expect(() => computeNewPaidUntil(null, new Date(), 0)).toThrow();
  });
});

describe('getEntitlement — grace-period boundaries (test 8)', () => {
  const paidUntil = iso('2026-06-01T00:00:00Z');
  it('active strictly before paid_until', () => {
    expect(getEntitlement(paidUntil, 3, new Date(paidUntil.getTime() - 1))).toBe('active');
  });
  it('not active at exactly paid_until; in grace instead', () => {
    expect(getEntitlement(paidUntil, 3, paidUntil)).toBe('grace');
  });
  it('expired exactly at paid_until when there is no grace', () => {
    expect(getEntitlement(paidUntil, 0, paidUntil)).toBe('expired');
  });
  it('grace up to (but excluding) paid_until + grace', () => {
    const end = new Date(paidUntil.getTime() + 3 * DAY_MS);
    expect(getEntitlement(paidUntil, 3, new Date(end.getTime() - 1))).toBe('grace');
    expect(getEntitlement(paidUntil, 3, end)).toBe('expired');
  });
  it('none when never paid', () => {
    expect(getEntitlement(null, 3, new Date())).toBe('none');
  });
});

describe('planReminders', () => {
  const settings = { ...DEFAULT_REMINDER_SETTINGS };
  it('plans 3d, 1d, expiry, grace-end in the Lagos sending window', () => {
    const paidUntil = iso('2026-07-10T14:00:00Z'); // 15:00 Lagos
    const r = planReminders({
      paidUntil,
      purchasedAt: iso('2026-06-10T14:00:00Z'),
      gracePeriodDays: 2,
      settings,
    });
    expect(r.map((x) => x.key)).toEqual(['before_3d', 'before_1d', 'on_expiry', 'grace_end']);
    for (const x of r) {
      const h = toZonedParts(x.dueAt, 'Africa/Lagos').hour;
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThan(20);
    }
  });
  it('skips reminder dates before the purchase (7-day plan bought late)', () => {
    const purchasedAt = iso('2026-07-08T10:00:00Z');
    const paidUntil = iso('2026-07-10T10:00:00Z');
    const r = planReminders({ paidUntil, purchasedAt, gracePeriodDays: 0, settings });
    expect(r.map((x) => x.key)).toEqual(['before_1d', 'on_expiry']);
  });
  it('a night-time expiry notice moves to the next morning (Lagos)', () => {
    const paidUntil = iso('2026-07-10T22:30:00Z'); // 23:30 Lagos
    const [onExpiry] = planReminders({
      paidUntil,
      purchasedAt: iso('2026-07-01T00:00:00Z'),
      gracePeriodDays: 0,
      settings: { ...settings, beforeExpiryDays: [] },
    });
    expect(onExpiry.dueAt.toISOString()).toBe('2026-07-11T07:00:00.000Z'); // 08:00 Lagos
  });
  it('a before-expiry reminder never slips past expiry', () => {
    const paidUntil = iso('2026-07-10T21:30:00Z'); // 22:30 Lagos
    const [oneDay] = planReminders({
      paidUntil,
      purchasedAt: iso('2026-07-01T00:00:00Z'),
      gracePeriodDays: 0,
      settings: { ...settings, beforeExpiryDays: [1], onExpiry: false },
    });
    expect(oneDay.dueAt.getTime()).toBeLessThan(paidUntil.getTime());
  });
  it('dedupe key includes org, membership, channel, type and paid_until', () => {
    expect(
      notificationDedupeKey({
        organizationId: 'o1',
        membershipId: 'm1',
        channel: 'WHATSAPP',
        reminderType: 'before_3d',
        paidUntil: iso('2026-07-10T14:00:00Z'),
      }),
    ).toBe('o1:m1:WHATSAPP:before_3d:2026-07-10T14:00:00.000Z');
  });
});

describe('time helpers', () => {
  it('adjusts early-morning Lagos time to 08:00 same day', () => {
    const d = adjustToSendingWindow(iso('2026-03-01T03:00:00Z'), 8, 20, 'Africa/Lagos');
    expect(d.toISOString()).toBe('2026-03-01T07:00:00.000Z');
  });
  it('adjusts across month/year end', () => {
    const d = adjustToSendingWindow(iso('2026-12-31T21:00:00Z'), 8, 20, 'Africa/Lagos');
    expect(d.toISOString()).toBe('2027-01-01T07:00:00.000Z');
  });
});

describe('CSV export formula-injection protection', () => {
  it('prefixes dangerous leading characters', () => {
    expect(escapeCsvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(escapeCsvCell('+2348031234567')).toBe("'+2348031234567");
    expect(escapeCsvCell('-1')).toBe("'-1");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('\tcmd')).toBe("'\tcmd");
    expect(escapeCsvCell('Ada, Lovelace')).toBe('"Ada, Lovelace"');
  });
  it('builds CRLF CSV', () => {
    expect(toCsv(['a', 'b'], [[1, '=x']])).toBe("a,b\r\n1,'=x\r\n");
  });
});

describe('phone normalization', () => {
  it('normalizes Nigerian numbers to E.164', () => {
    expect(normalizePhoneE164('0803 123 4567')).toBe('+2348031234567');
    expect(normalizePhoneE164('+234 803 123 4567')).toBe('+2348031234567');
    expect(normalizePhoneE164('12345')).toBeNull();
  });
});
