'use client';

import { FormEvent, useState } from 'react';
import { formatDateTime } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Badge, Button, Card, ErrorAlert, Field, Loading, PageHeader, Select } from '@/components/ui';

export default function AdminIntegrations() {
  const { data, error, loading, reload } = useApi<any>('/admin/integrations');
  const [t, setT] = useState({ purpose: 'PAYMENT_CONFIRMATION', name: '', language: 'en', category: 'UTILITY', status: 'PENDING' });
  const [err, setErr] = useState<ApiError | null>(null);
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const c = data.config;
  const ok = (b: boolean) => <Badge color={b ? 'green' : 'red'}>{b ? 'Yes' : 'No'}</Badge>;
  async function save(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api('/admin/templates', { method: 'PUT', body: t });
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  }
  return (
    <>
      <PageHeader title="Integration health" subtitle={`Mode: ${c.appMode}. Secrets are configured via environment variables and never displayed.`} />
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Card title="Paystack"><p className="text-sm">Configured {ok(c.paystack.configured)} · Live keys {ok(c.paystack.liveMode)}</p><p className="mt-1 text-sm text-gray-600">Last webhook: {data.lastPaystackEvent ? `${data.lastPaystackEvent.eventType} at ${formatDateTime(data.lastPaystackEvent.receivedAt)}` : 'none'}</p></Card>
          <Card title="WhatsApp Cloud API"><p className="text-sm">Enabled {ok(c.whatsapp.enabled)} · Configured {ok(c.whatsapp.configured)}</p><p className="mt-1 text-sm text-gray-600">Graph {c.whatsapp.graphVersion} · last webhook {data.lastWhatsappEvent ? formatDateTime(data.lastWhatsappEvent.receivedAt) : 'none'}</p></Card>
          <Card title="Email (Resend)"><p className="text-sm">Enabled {ok(c.email.enabled)} · Configured {ok(c.email.configured)}</p><p className="mt-1 text-sm text-gray-600">From: {c.email.from}</p></Card>
        </div>
        <Card title="Queues">
          <p className="text-sm">Redis: <Badge color={data.redis === 'ok' ? 'green' : data.redis === 'disabled' ? 'gray' : 'red'}>{data.redis}</Badge> · Unprocessed webhook events: {data.unprocessedEvents}</p>
          <p className="mt-1 text-sm">Last 24h — sent: {data.sent24h.map((s: any) => `${s.channel} ${s._count}`).join(', ') || '0'} · failed/needs review: {data.failures24h.map((s: any) => `${s.channel} ${s._count}`).join(', ') || '0'}</p>
        </Card>
        <Card title="WhatsApp templates">
          <Alert kind="info">Templates must be created and approved in WhatsApp Manager first. Record the exact name, language and the category Meta assigned. Only APPROVED templates are used; others pause that message type.</Alert>
          <ul className="my-3 divide-y divide-gray-100 text-sm">
            {data.templates.map((x: any) => <li key={x.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{x.purpose} → <span className="font-mono">{x.name}</span> ({x.language}, {x.category})</span><Badge color={x.status === 'APPROVED' ? 'green' : x.status === 'REJECTED' ? 'red' : 'amber'}>{x.status}</Badge></li>)}
          </ul>
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-5 sm:items-end">
            <Select label="Purpose" value={t.purpose} onChange={(e) => setT({ ...t, purpose: e.target.value })}>{['PAYMENT_CONFIRMATION', 'ACCESS_INSTRUCTIONS', 'RENEWAL_REMINDER', 'EXPIRY_NOTICE'].map((p) => <option key={p}>{p}</option>)}</Select>
            <Field label="Template name" required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
            <Field label="Language" required value={t.language} onChange={(e) => setT({ ...t, language: e.target.value })} />
            <Select label="Category" value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })}><option>UTILITY</option><option>MARKETING</option></Select>
            <Select label="Status" value={t.status} onChange={(e) => setT({ ...t, status: e.target.value })}>{['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'].map((s) => <option key={s}>{s}</option>)}</Select>
            <div className="sm:col-span-5"><Button type="submit">Save template</Button></div>
          </form>
          <ErrorAlert error={err} />
        </Card>
      </div>
    </>
  );
}
