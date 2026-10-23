'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { SUBSCRIPTION_ACCESS_LABELS, formatDate, formatDateTime, formatNgn } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Badge, Button, Card, cx, ErrorAlert, Loading, PageHeader, ResponsiveTable, Empty } from '@/components/ui';
import { useMe } from '@/components/me-context';

const ACCESS_COLOR: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = {
  trialing: 'blue',
  active: 'green',
  past_due: 'amber',
  paused: 'red',
  cancelled: 'gray',
};

function Usage({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-gray-700">{label}</span>
        <span className="font-medium">{used} / {max ?? 'Unlimited'}</span>
      </div>
      {max !== null && (
        <div className="mt-1 h-2 rounded-full bg-gray-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={cx('h-2 rounded-full', pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Billing() {
  const me = useMe();
  const owner = me.role === 'OWNER';
  const router = useRouter();
  const reference = useSearchParams().get('reference');
  const { data: b, error, loading, reload } = useApi<any>('/org/billing');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const checked = useRef(false);

  // Returning from the card checkout: verify server-side (the redirect alone proves nothing).
  useEffect(() => {
    if (!reference || checked.current || !/^SUB-[A-Z0-9]{16}$/.test(reference)) return;
    checked.current = true;
    let n = 0;
    const tick = async () => {
      try {
        const r = await api<{ status: string }>(`/org/billing/verify/${reference}`, { body: {} });
        if (r.status === 'PAID') {
          setMsg('Payment received — thank you! Your card will be charged automatically each month.');
          router.replace('/creator/billing');
          await reload();
        } else if (r.status === 'PENDING' && n++ < 10) {
          setMsg('Confirming your payment…');
          setTimeout(tick, 3000);
        } else if (r.status !== 'PENDING') {
          setMsg(null);
          setErr(new ApiError(400, 'PAYMENT_FAILED', 'The payment was not completed. You have not been charged.'));
          router.replace('/creator/billing');
        }
      } catch (e) {
        setErr(e as ApiError);
      }
    };
    void tick();
  }, [reference, reload, router]);

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function payNow() {
    setBusy('pay');
    setErr(null);
    try {
      const r = await api<{ checkoutUrl: string }>('/org/billing/checkout', { body: {} });
      window.location.assign(r.checkoutUrl);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(null);
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const s = b.subscription;
  const current = b.tiers.find((t: any) => t.tier === s.tier);
  const order = ['STARTER', 'GROWTH', 'PRO'];

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Your CommunityPass subscription. Member payments always go 100% to your own bank account through Paystack — this is separate."
      />
      {msg && <div className="mb-4"><Alert kind="success">{msg}</Alert></div>}
      <ErrorAlert error={err} />

      {s.access === 'past_due' && (
        <div className="mb-4">
          <Alert kind="warning" title="Payment overdue">
            Pay by {formatDateTime(s.graceEndsAt)} to keep taking member payments. {s.failedAttempts > 0 && `We tried your card ${s.failedAttempts} time(s) and will retry automatically.`}
          </Alert>
        </div>
      )}
      {(s.access === 'paused' || s.access === 'cancelled') && (
        <div className="mb-4">
          <Alert kind="error" title="New member payments are paused">
            Your community pages are not taking payments. Existing members keep the time they already paid for. Pay now to resume immediately.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Your plan" actions={<Badge color={ACCESS_COLOR[s.access]}>{SUBSCRIPTION_ACCESS_LABELS[s.access as keyof typeof SUBSCRIPTION_ACCESS_LABELS]}</Badge>}>
          <p className="text-2xl font-bold">{current.name} <span className="text-base font-normal text-gray-600">· {formatNgn(current.priceKobo)}/month</span></p>
          {s.pendingTier && <p className="mt-1 text-sm text-amber-800">Changes to {b.tiers.find((t: any) => t.tier === s.pendingTier).name} at your next renewal.</p>}
          <dl className="mt-3 space-y-1 text-sm">
            {s.access === 'trialing' && <div><dt className="inline text-gray-500">Free trial ends: </dt><dd className="inline font-medium">{formatDateTime(s.trialEndsAt)}</dd></div>}
            {s.currentPeriodEnd && <div><dt className="inline text-gray-500">{s.autoRenew ? 'Next charge' : 'Paid until'}: </dt><dd className="inline font-medium">{formatDate(s.paidThrough)}{s.autoRenew && ` · ${formatNgn(s.priceKobo)}`}</dd></div>}
            <div><dt className="inline text-gray-500">Card: </dt><dd className="inline">{s.card ? `${s.card.brand ?? 'Card'} •••• ${s.card.last4}${s.card.expiry ? ` (exp ${s.card.expiry})` : ''}` : 'No card saved'}</dd></div>
            <div><dt className="inline text-gray-500">Auto-renew: </dt><dd className="inline">{s.autoRenew ? 'On' : s.cancelAtPeriodEnd ? 'Off (cancelled)' : 'Off'}</dd></div>
          </dl>
          {owner && (
            <div className="mt-4 flex flex-wrap gap-2">
              {(!s.autoRenew || s.access === 'past_due' || s.access === 'paused' || s.access === 'cancelled') && (
                <Button onClick={payNow} loading={busy === 'pay'}>
                  {s.card ? `Pay ${formatNgn(s.priceKobo)} now` : `Add card & subscribe (${formatNgn(s.priceKobo)})`}
                </Button>
              )}
              {s.autoRenew && (
                <Button variant="secondary" loading={busy === 'cancel'} onClick={() => confirm('Turn off auto-renew? You keep access until your paid period ends.') && act('cancel', () => api('/org/billing/cancel', { body: {} }), 'Auto-renew turned off.')}>
                  Cancel auto-renew
                </Button>
              )}
              {s.cancelAtPeriodEnd && s.card && (
                <Button variant="secondary" loading={busy === 'resume'} onClick={() => act('resume', () => api('/org/billing/resume', { body: {} }), 'Auto-renew turned back on.')}>
                  Resume auto-renew
                </Button>
              )}
            </div>
          )}
          {s.access === 'trialing' && !s.card && (
            <p className="mt-3 text-sm text-gray-600">Adding your card now doesn&apos;t cut your trial short — your first paid month starts when the trial ends.</p>
          )}
          {!owner && <p className="mt-3 text-sm text-gray-600">Only the owner can change billing.</p>}
        </Card>

        <Card title="Usage">
          <div className="space-y-4">
            <Usage label="Communities" used={b.usage.communities} max={b.limits.maxCommunities} />
            <Usage label="Active paid members" used={b.usage.activeMembers} max={b.limits.maxActiveMembers} />
            <p className="text-sm text-gray-600">
              WhatsApp reminders: {b.whatsappAllowed ? 'included' : 'not included (Growth and Pro plans)'}. When you reach your member limit, new signups are blocked until you upgrade; existing members can still renew.
            </p>
          </div>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Plans</h2>
      <div className="grid gap-3 md:grid-cols-3">
        {b.tiers.map((t: any) => {
          const isCurrent = t.tier === s.tier;
          const up = order.indexOf(t.tier) > order.indexOf(s.tier);
          return (
            <div key={t.tier} className={cx('rounded-xl border bg-white p-5', isCurrent ? 'border-brand-600 ring-2 ring-brand-100' : 'border-gray-200')}>
              <p className="text-lg font-semibold">{t.name}</p>
              <p className="mt-1 text-2xl font-bold">{formatNgn(t.priceKobo)}<span className="text-sm font-normal text-gray-600">/month</span></p>
              <ul className="mt-3 space-y-1 text-sm text-gray-700">
                <li>✓ {t.maxCommunities === null ? 'Unlimited communities' : `${t.maxCommunities} ${t.maxCommunities === 1 ? 'community' : 'communities'}`}</li>
                <li>✓ {t.maxActiveMembers === null ? 'Unlimited active members' : `Up to ${t.maxActiveMembers} active paid members`}</li>
                <li>✓ Email receipts & reminders</li>
                <li>{t.whatsappReminders ? '✓ WhatsApp reminders' : '✗ No WhatsApp reminders'}</li>
                <li>✓ Access task queue, member portal</li>
              </ul>
              <div className="mt-4">
                {isCurrent ? (
                  <Badge color="green">Current plan</Badge>
                ) : owner ? (
                  <Button
                    size="sm"
                    variant={up ? 'primary' : 'secondary'}
                    loading={busy === t.tier}
                    onClick={() =>
                      act(t.tier, async () => {
                        const r = await api<{ effective: string }>('/org/billing/plan', { body: { tier: t.tier } });
                        setMsg(r.effective === 'next_renewal' ? `${t.name} will start at your next renewal.` : `You're now on ${t.name}.`);
                      })
                    }
                  >
                    {up ? `Upgrade to ${t.name}` : `Switch to ${t.name}`}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-gray-600">Upgrades apply immediately; the new price starts at your next renewal. Downgrades apply at your next renewal.</p>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Invoices</h2>
      <ResponsiveTable
        rows={b.invoices}
        rowKey={(r: any) => r.id}
        empty={<Empty title="No invoices yet" />}
        columns={[
          { header: 'Date', primary: true, cell: (r: any) => formatDateTime(r.paidAt ?? r.createdAt) },
          { header: 'Plan', cell: (r: any) => `${r.tier.charAt(0)}${r.tier.slice(1).toLowerCase()}${r.kind === 'RENEWAL' ? ' (auto-renewal)' : ''}` },
          { header: 'Amount', cell: (r: any) => <>{formatNgn(r.amountKobo)} {r.provider === 'DEMO' && <Badge color="purple">Demo</Badge>}</> },
          { header: 'Period', cell: (r: any) => (r.periodStart ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}` : '—') },
          { header: 'Status', cell: (r: any) => <Badge color={r.status === 'PAID' ? 'green' : r.status === 'PENDING' ? 'amber' : 'red'}>{r.status.toLowerCase()}</Badge> },
          { header: 'Note', cell: (r: any) => <span className="text-xs text-gray-600">{r.failureReason ?? ''}</span> },
        ]}
      />
    </>
  );
}

export default function BillingPage() {
  return <Suspense fallback={<Loading />}><Billing /></Suspense>;
}
