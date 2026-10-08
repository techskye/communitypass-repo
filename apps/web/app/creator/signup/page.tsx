'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Field } from '@/components/ui';

export default function CreatorSignup() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/auth/signup', { body: form });
      router.replace('/creator/onboarding');
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  }
  const fe = (k: string) => err?.issues?.find((i) => i.path === k)?.message;
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="mb-6 text-2xl font-bold">Create your creator account</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Your name" required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fe('name')} />
          <Field label="Email" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={fe('email')} />
          <Field label="Password" type="password" required autoComplete="new-password" minLength={10} hint="At least 10 characters." value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} error={fe('password')} />
          {err && !err.issues && <Alert kind="error">{err.message}</Alert>}
          <Button type="submit" loading={busy} className="w-full">Create account</Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-gray-600">
        Already have an account? <Link href="/creator/login" className="text-brand-700 underline">Sign in</Link>
      </p>
    </main>
  );
}
