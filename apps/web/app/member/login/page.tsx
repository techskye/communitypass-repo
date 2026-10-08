'use client';

import { FormEvent, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Field } from '@/components/ui';

export default function MemberLogin() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [demoLink, setDemoLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; demoLink?: string }>('/member/auth/magic-link', { body: { email } });
      setSent(true);
      setDemoLink(r.demoLink ?? null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="mb-2 text-2xl font-bold">Member sign-in</h1>
      <p className="mb-6 text-gray-600">We&apos;ll email you a sign-in link. No password needed.</p>
      <Card>
        {sent ? (
          <div className="space-y-3">
            <Alert kind="success" title="Check your email">
              If {email} has a membership, a sign-in link is on its way. It expires in 15 minutes and works once.
            </Alert>
            {demoLink && (
              <Alert kind="info" title="Demo mode">
                Emails are not really sent in demo mode. <a href={demoLink} className="font-medium underline">Use this one-time sign-in link</a>.
              </Alert>
            )}
            <Button variant="ghost" onClick={() => setSent(false)}>Use a different email</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email you used to join" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            {err && <Alert kind="error">{err}</Alert>}
            <Button type="submit" loading={busy} className="w-full">Email me a sign-in link</Button>
          </form>
        )}
      </Card>
    </main>
  );
}
