'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Button, Card, Checkbox, ErrorAlert, Field, Loading, PageHeader } from '@/components/ui';

function PrefCard({ p, onSaved }: { p: any; onSaved: () => void }) {
  const [state, setState] = useState({ emailReminders: p.emailReminders, whatsappOptIn: p.whatsappOptIn, phone: p.phone });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => setState({ emailReminders: p.emailReminders, whatsappOptIn: p.whatsappOptIn, phone: p.phone }), [p]);

  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api(`/member/preferences/${p.memberId}`, { method: 'PUT', body: state });
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={p.creator}>
      <div className="space-y-4">
        <Field label="WhatsApp phone number" type="tel" value={state.phone} onChange={(e) => setState({ ...state, phone: e.target.value })} hint="The number the creator adds to the WhatsApp group." />
        <Checkbox
          checked={state.whatsappOptIn}
          onChange={(e) => setState({ ...state, whatsappOptIn: e.target.checked })}
          label="WhatsApp membership updates"
          hint={p.consentWording}
        />
        <Checkbox
          checked={state.emailReminders}
          onChange={(e) => setState({ ...state, emailReminders: e.target.checked })}
          label="Email renewal reminders"
          hint="Payment receipts are always emailed."
        />
        <p className="text-sm text-gray-600">Turning off messages does not cancel your membership.</p>
        {msg && <Alert kind="success">{msg}</Alert>}
        <ErrorAlert error={err} />
        <Button onClick={save} loading={busy}>Save</Button>
      </div>
    </Card>
  );
}

export default function Preferences() {
  const { data, error, loading, reload } = useApi<any[]>('/member/preferences');
  return (
    <>
      <PageHeader title="Notification preferences" subtitle="Choose how each creator can reach you about your membership." />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      <div className="space-y-4">{data?.map((p) => <PrefCard key={p.memberId} p={p} onSaved={reload} />)}</div>
      <p className="mt-6 text-sm text-gray-600">You can also reply STOP to any CommunityPass WhatsApp message to stop WhatsApp messages from all creators.</p>
    </>
  );
}
