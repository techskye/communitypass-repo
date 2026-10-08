'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { formatNgn, PLAN_DURATION_LABELS, PlanDurationDays } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Button, Card, Checkbox, Field, Loading, ErrorAlert } from '@/components/ui';

function JoinForm() {
  const { slug } = useParams<{ slug: string }>();
  const planId = useSearchParams().get('plan');
  const { data: c, error, loading } = useApi<any>(`/public/communities/${slug}`);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '' });
  const [whatsappOptIn, setWhatsappOptIn] = useState(false); // unchecked by default — explicit opt-in only
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  const plan = c?.plans.find((p: any) => p.id === planId);
  if (!plan) {
    return (
      <Alert kind="warning">
        Please <Link href={`/c/${slug}`} className="underline">choose a plan</Link> first.
      </Alert>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const r = await api<{ checkoutUrl: string }>('/public/checkout', {
        body: { communitySlug: slug, planId, ...form, whatsappOptIn, acceptTerms },
      });
      window.location.assign(r.checkoutUrl);
    } catch (e) {
      setErr(e as ApiError);
      setSubmitting(false);
    }
  }

  const fieldErr = (k: string) => err?.issues?.find((i) => i.path === k)?.message;

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Card>
        <p className="text-sm text-gray-600">{c.name} · {c.creator.displayName}</p>
        <p className="mt-1 text-lg font-semibold">
          {plan.name} — {formatNgn(plan.priceKobo)}
        </p>
        <p className="text-sm text-gray-600">
          {PLAN_DURATION_LABELS[plan.durationDays as PlanDurationDays]} of access from when your payment is confirmed. One-time payment; nothing renews automatically.
        </p>
      </Card>

      <Card title="Your details">
        <div className="space-y-4">
          <Field label="Full name" required autoComplete="name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} error={fieldErr('fullName')} />
          <Field
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            hint="Used for your receipt and to sign in to your member page."
            error={fieldErr('email')}
          />
          <Field
            label="WhatsApp phone number"
            type="tel"
            required
            autoComplete="tel"
            inputMode="tel"
            placeholder="0803 123 4567 or +234 803 123 4567"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            hint={`The number ${c.creator.displayName} will add to the WhatsApp group.`}
            error={fieldErr('phone')}
          />
        </div>
      </Card>

      <Card title="Messages">
        <div className="space-y-4">
          <Checkbox
            checked={whatsappOptIn}
            onChange={(e) => setWhatsappOptIn(e.target.checked)}
            label={<span className="font-medium">Send me membership updates on WhatsApp (optional)</span>}
            hint={
              <>
                {c.whatsappConsentText} Messages come from the CommunityPass WhatsApp business number, not from {c.creator.displayName}&apos;s personal number. You can still join without this.
              </>
            }
          />
          <p className="text-sm text-gray-600">We&apos;ll email your receipt and membership notices. You can turn off email reminders later.</p>
        </div>
      </Card>

      <Checkbox
        checked={acceptTerms}
        onChange={(e) => setAcceptTerms(e.target.checked)}
        required
        label={
          <>
            I agree to the <Link href="/terms" target="_blank" className="text-brand-700 underline">membership terms</Link> and{' '}
            <Link href="/privacy" target="_blank" className="text-brand-700 underline">privacy notice</Link>.
          </>
        }
      />

      {err && !err.issues?.length && <ErrorAlert error={err} />}
      {err?.issues?.length ? <Alert kind="error">Please fix the highlighted fields.</Alert> : null}

      <Button type="submit" loading={submitting} disabled={!acceptTerms} className="w-full">
        {c.isDemoCheckout ? 'Continue to demo checkout' : `Pay ${formatNgn(plan.priceKobo)} with Paystack`}
      </Button>
      <p className="text-center text-xs text-gray-500">
        {c.isDemoCheckout ? 'Demo mode: no real payment will be taken.' : 'You’ll be taken to Paystack’s secure checkout. We never see or store your card details.'}
      </p>
    </form>
  );
}

export default function JoinPage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold">Join</h1>
      <Suspense fallback={<Loading />}>
        <JoinForm />
      </Suspense>
    </main>
  );
}
