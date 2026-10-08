'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Field } from '@/components/ui';

export default function CreatorLogin() {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ isPlatformAdmin: boolean }>('/auth/login', { body: form });
      router.replace(r.isPlatformAdmin ? '/admin' : '/creator');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not sign in');
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="mb-6 text-2xl font-bold">Creator sign-in</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Field label="Password" type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {err && <Alert kind="error">{err}</Alert>}
          <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-gray-600">
        New to CommunityPass? <Link href="/creator/signup" className="text-brand-700 underline">Create an account</Link>
      </p>
    </main>
  );
}
