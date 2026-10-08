'use client';

import { FormEvent, useState } from 'react';
import { formatDate } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Badge, Button, Card, ErrorAlert, Field, Loading, PageHeader, Select } from '@/components/ui';
import { useMe } from '@/components/me-context';

export default function Staff() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<any>('/org/staff');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('STAFF');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const owner = me.role === 'OWNER';

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  }
  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await act(() => api('/org/staff/invite', { body: { email, role } }), `Invite sent to ${email}.`);
    setEmail('');
    setBusy(false);
  }
  return (
    <>
      <PageHeader title="Team" subtitle="Staff can work the task queue and view members and payments. Owners can also change settings, plans and the team." />
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      <ErrorAlert error={err} />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <div className="space-y-4">
          <Card title="Members of your team">
            <ul className="divide-y divide-gray-100">
              {data.members.map((m: any) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{m.name} <span className="text-sm text-gray-500">{m.email}</span> <Badge color={m.role === 'OWNER' ? 'green' : 'gray'}>{m.role === 'OWNER' ? 'Owner' : 'Staff'}</Badge></span>
                  {owner && m.id !== me.user.id && <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${m.name}?`) && act(() => api(`/org/staff/${m.id}`, { method: 'DELETE' }), 'Removed.')}>Remove</Button>}
                </li>
              ))}
            </ul>
          </Card>
          {data.invites.length > 0 && (
            <Card title="Pending invites">
              <ul className="divide-y divide-gray-100">
                {data.invites.map((i: any) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span>{i.email} · {i.role} · expires {formatDate(i.expiresAt)}</span>
                    {owner && <Button size="sm" variant="ghost" onClick={() => act(() => api(`/org/staff/invites/${i.id}`, { method: 'DELETE' }), 'Invite revoked.')}>Revoke</Button>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {owner && (
            <Card title="Invite someone">
              <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
                <Field label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="STAFF">Staff</option>
                  <option value="OWNER">Owner</option>
                </Select>
                <Button type="submit" loading={busy}>Send invite</Button>
              </form>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
