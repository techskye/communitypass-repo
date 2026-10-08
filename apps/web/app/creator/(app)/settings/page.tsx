'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Button, Card, ErrorAlert, Field, Loading, PageHeader } from '@/components/ui';
import { useMe } from '@/components/me-context';

export default function Settings() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<any>('/org/profile');
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setP({ ...data, supportWhatsapp: data.supportWhatsapp ?? '' }); }, [data]);
  if (loading || !p) return error ? <ErrorAlert error={error} onRetry={reload} /> : <Loading />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api('/org/profile', { method: 'PUT', body: { name: p.name, displayName: p.displayName, supportEmail: p.supportEmail, supportWhatsapp: p.supportWhatsapp } });
      setSaved(true);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader title="Settings" />
      <form onSubmit={submit}>
        <Card title="Organization profile">
          <fieldset disabled={me.role !== 'OWNER'} className="space-y-4">
            <Field label="Organization name" required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
            <Field label="Display name" required value={p.displayName} onChange={(e) => setP({ ...p, displayName: e.target.value })} />
            <Field label="Support email" type="email" required value={p.supportEmail} onChange={(e) => setP({ ...p, supportEmail: e.target.value })} />
            <Field label="Support WhatsApp number (optional)" type="tel" value={p.supportWhatsapp} onChange={(e) => setP({ ...p, supportWhatsapp: e.target.value })} hint="Shown to your members for help." />
            <p className="text-sm text-gray-600">Times are shown in {p.timezone} (Lagos time).</p>
            {saved && <Alert kind="success">Saved.</Alert>}
            <ErrorAlert error={err} />
            {me.role === 'OWNER' && <Button type="submit" loading={busy}>Save</Button>}
          </fieldset>
        </Card>
      </form>
    </>
  );
}
