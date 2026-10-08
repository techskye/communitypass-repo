'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Field } from '@/components/ui';

export default function AcceptInvite() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setToken(new URLSearchParams(window.location.hash.slice(1)).get('token'));
    history.replaceState(null, '', window.location.pathname);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/auth/accept-invite', { body: { token, ...form } });
      router.replace('/creator');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not accept invite');
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="mb-6 text-2xl font-bold">Join your team on CommunityPass</h1>
      <Card>
        {!token ? (
          <Alert kind="error">This invite link is incomplete. Ask the owner to send a new invite.</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Your name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Field label="Password" type="password" required minLength={10} autoComplete="new-password" hint="If you already have a CommunityPass account, enter your existing password." value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            {err && <Alert kind="error">{err}</Alert>}
            <Button type="submit" loading={busy} className="w-full">Accept invite</Button>
          </form>
        )}
      </Card>
    </main>
  );
}
