'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime, formatNgn, PLAN_DURATION_LABELS, PlanDurationDays } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { AccessBadge, Alert, Button, Card, DemoBadge, EntitlementBadge, ErrorAlert, Loading, PageHeader, PaymentBadge } from '@/components/ui';

export default function MembershipDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: m, error, loading, reload } = useApi<any>(`/member/memberships/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [showLink, setShowLink] = useState(false);

  async function renew() {
    setBusy('renew');
    setErr(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/member/memberships/${id}/renew`, { body: {} });
      window.location.assign(r.checkoutUrl);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(null);
    }
  }
  async function cancel() {
    if (!confirm('Stop renewing? You keep the time you have already paid for.')) return;
    setBusy('cancel');
    try {
      await api(`/member/memberships/${id}/cancel`, { body: {} });
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  if (!m) return null;
  const dur = PLAN_DURATION_LABELS[m.plan.durationDays as PlanDurationDays] ?? `${m.plan.durationDays} days`;

  return (
    <>
      <PageHeader title={m.community.name} subtitle={`by ${m.creator.displayName}`} actions={<EntitlementBadge value={m.entitlement} />} />
      <div className="space-y-4">
        <Card title="Membership">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-500">Plan</dt><dd className="font-medium">{m.plan.name} · {dur} · {formatNgn(m.plan.priceKobo)}</dd></div>
            <div><dt className="text-gray-500">Paid until (Lagos time)</dt><dd className="font-medium">{formatDateTime(m.paidUntil)}</dd></div>
            {m.graceEndsAt && <div><dt className="text-gray-500">Grace period ends</dt><dd>{formatDateTime(m.graceEndsAt)}</dd></div>}
            <div><dt className="text-gray-500">WhatsApp group</dt><dd><AccessBadge value={m.accessStatus} /></dd></div>
          </dl>
          {m.entitlement === 'grace' && <div className="mt-3"><Alert kind="warning">Your paid time has ended. You&apos;re in a grace period — renew before {formatDateTime(m.graceEndsAt)} to avoid being removed.</Alert></div>}
          <div className="mt-4 flex flex-wrap gap-2">
            {m.plan.isActive && (
              <Button onClick={renew} loading={busy === 'renew'}>
                {m.entitlement === 'active' ? `Renew early (+${dur})` : `Renew (${dur})`}
              </Button>
            )}
            {!m.cancelled && m.entitlement === 'active' && (
              <Button variant="secondary" onClick={cancel} loading={busy === 'cancel'}>Don&apos;t renew</Button>
            )}
          </div>
          {m.entitlement === 'active' && <p className="mt-2 text-sm text-gray-600">Renewing early adds {dur} to the end of your current paid time — you don&apos;t lose any days.</p>}
          {m.cancelled && <p className="mt-2 text-sm text-gray-600">You&apos;ve chosen not to renew. You keep access until your paid time (and any grace period) ends.</p>}
          {err && <div className="mt-3"><ErrorAlert error={err} /></div>}
        </Card>

        <Card title="How to join the WhatsApp group">
          {m.access ? (
            <div className="space-y-3 text-sm">
              {m.access.instructions && <p className="whitespace-pre-line">{m.access.instructions}</p>}
              {showLink ? (
                <p>
                  <a href={m.access.inviteUrl} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-brand-700 underline">
                    Open the WhatsApp group invite
                  </a>
                </p>
              ) : (
                <Button variant="secondary" onClick={() => setShowLink(true)}>Show invite link</Button>
              )}
              <Alert kind="info">
                {m.community.adminApprovalEnabled
                  ? `${m.creator.displayName} approves join requests manually, so it may take a little while before you're added.`
                  : `${m.creator.displayName} manages the group manually.`}{' '}
                This link is for you only — please don&apos;t share it.
              </Alert>
            </div>
          ) : (
            <p className="text-sm text-gray-700">Access instructions are shown while your membership is paid (or in its grace period). Renew to see them.</p>
          )}
        </Card>

        <Card title="Payment history">
          {m.payments.length ? (
            <ul className="divide-y divide-gray-100 text-sm">
              {m.payments.map((p: any) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{formatDateTime(p.paidAt)} · {formatNgn(p.amountKobo)} · +{p.durationDays} days {p.isDemo && <DemoBadge />}</span>
                  <PaymentBadge value={p.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-600">No confirmed payments yet.</p>
          )}
        </Card>

        <Card title="Need help?">
          <p className="text-sm text-gray-700">
            Contact {m.creator.displayName}: <a className="text-brand-700 underline" href={`mailto:${m.creator.supportEmail}`}>{m.creator.supportEmail}</a>
            {m.creator.supportWhatsapp && <> · WhatsApp {m.creator.supportWhatsapp}</>}
          </p>
        </Card>
      </div>
    </>
  );
}
