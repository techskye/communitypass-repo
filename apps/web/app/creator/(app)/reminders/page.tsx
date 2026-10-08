'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Button, Card, Checkbox, ErrorAlert, Loading, PageHeader, Select } from '@/components/ui';
import { useMe } from '@/components/me-context';

export default function Reminders() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<any>('/org/reminder-settings');
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setS(data); }, [data]);
  if (loading || !s) return error ? <ErrorAlert error={error} onRetry={reload} /> : <Loading />;
  const toggleDay = (d: number, on: boolean) => setS({ ...s, beforeExpiryDays: on ? [...new Set([...s.beforeExpiryDays, d])].sort((a: number, b: number) => b - a) : s.beforeExpiryDays.filter((x: number) => x !== d) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const { beforeExpiryDays, onExpiry, graceEnd, sendWindowStartHour, sendWindowEndHour, maxMessagesPerMemberPerDay, creatorDigestEnabled, whatsappEnabled, emailEnabled } = s;
      await api('/org/reminder-settings', { method: 'PUT', body: { beforeExpiryDays, onExpiry, graceEnd, sendWindowStartHour, sendWindowEndHour, maxMessagesPerMemberPerDay, creatorDigestEnabled, whatsappEnabled, emailEnabled } });
      setSaved(true);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const hours = Array.from({ length: 25 }, (_, h) => h);
  return (
    <>
      <PageHeader title="Reminder settings" subtitle="Automatic membership messages. Reminders are skipped if a member renews or opts out." />
      <form onSubmit={submit}>
        <fieldset disabled={me.role !== 'OWNER'} className="space-y-4">
          <Card title="When to remind members">
            <div className="space-y-3">
              {[7, 3, 1].map((d) => <Checkbox key={d} checked={s.beforeExpiryDays.includes(d)} onChange={(e) => toggleDay(d, e.target.checked)} label={`${d} day${d > 1 ? 's' : ''} before paid time ends`} />)}
              <Checkbox checked={s.onExpiry} onChange={(e) => setS({ ...s, onExpiry: e.target.checked })} label="When paid time ends" />
              <Checkbox checked={s.graceEnd} onChange={(e) => setS({ ...s, graceEnd: e.target.checked })} label="When the grace period ends (if you use one)" />
            </div>
          </Card>
          <Card title="Sending hours and limits (Lagos time)">
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Start sending from" value={s.sendWindowStartHour} onChange={(e) => setS({ ...s, sendWindowStartHour: Number(e.target.value) })}>{hours.slice(0, 24).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select>
              <Select label="Stop sending at" value={s.sendWindowEndHour} onChange={(e) => setS({ ...s, sendWindowEndHour: Number(e.target.value) })}>{hours.slice(1).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select>
              <Select label="Max reminders per member per day" value={s.maxMessagesPerMemberPerDay} onChange={(e) => setS({ ...s, maxMessagesPerMemberPerDay: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            </div>
          </Card>
          <Card title="Channels">
            <div className="space-y-3">
              <Checkbox checked={s.whatsappEnabled} onChange={(e) => setS({ ...s, whatsappEnabled: e.target.checked })} label="WhatsApp (only to members who opted in)" hint="Sent from the CommunityPass WhatsApp number on your behalf, using pre-approved message templates." />
              <Checkbox checked={s.emailEnabled} onChange={(e) => setS({ ...s, emailEnabled: e.target.checked })} label="Email" hint="Members can turn off email reminders themselves. Receipts are always sent." />
              <Checkbox checked={s.creatorDigestEnabled} onChange={(e) => setS({ ...s, creatorDigestEnabled: e.target.checked })} label="Send me a daily email of access tasks (7am Lagos)" />
            </div>
          </Card>
          {saved && <Alert kind="success">Saved.</Alert>}
          <ErrorAlert error={err} />
          {me.role === 'OWNER' ? <Button type="submit" loading={busy}>Save settings</Button> : <p className="text-sm text-gray-600">Only the owner can change these settings.</p>}
          <p className="text-sm text-gray-600">CommunityPass does not send bulk or promotional messages. Only membership-related messages are sent.</p>
        </fieldset>
      </form>
    </>
  );
}
