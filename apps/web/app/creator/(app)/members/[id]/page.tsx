'use client';

import { useParams } from 'next/navigation';
import { formatDateTime, formatNgn, TASK_TYPE_LABELS } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { AccessBadge, Badge, Card, DemoBadge, EntitlementBadge, ErrorAlert, Loading, NotificationBadge, OrderBadge, PageHeader, PaymentBadge } from '@/components/ui';

export default function MemberDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: m, error, loading, reload } = useApi<any>(`/org/members/${id}`);
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const wa = m.consents.find((c: any) => c.channel === 'WHATSAPP');
  return (
    <>
      <PageHeader title={m.fullName} subtitle={<>{m.email} · <span className="font-mono">{m.phoneE164}</span></>} />
      <div className="space-y-4">
        <Card title="Memberships">
          <ul className="space-y-3">
            {m.memberships.map((ms: any) => (
              <li key={ms.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{ms.community.name} · {ms.plan.name}</span>
                  <div className="flex gap-2"><EntitlementBadge value={ms.entitlement} /><AccessBadge value={ms.accessStatus} /></div>
                </div>
                <p className="mt-1">Paid until {formatDateTime(ms.paidUntil)} {ms.cancelledAt && <span className="text-gray-500">· not renewing</span>}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-brand-700">Paid-time history</summary>
                  <ul className="mt-2 space-y-1">
                    {ms.applications.map((a: any) => (
                      <li key={a.id}>
                        {formatDateTime(a.payment.paidAt)}: +{a.durationDays} days → {formatDateTime(a.newPaidUntil)} ({formatNgn(a.payment.amountKobo)}) <PaymentBadge value={a.payment.status} /> {a.payment.provider === 'DEMO' && <DemoBadge />}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
            {!m.memberships.length && <li className="text-gray-600">No paid memberships yet.</li>}
          </ul>
        </Card>
        <Card title="Messaging consent">
          <p className="text-sm">
            WhatsApp: {wa ? <Badge color={wa.status === 'GRANTED' ? 'green' : 'gray'}>{wa.status === 'GRANTED' ? 'Opted in' : 'Opted out'}</Badge> : <Badge>Not opted in</Badge>}
            {wa && <span className="ml-2 text-gray-500">({wa.source}, {formatDateTime(wa.status === 'GRANTED' ? wa.grantedAt : wa.withdrawnAt)}, wording {wa.wordingVersion})</span>}
          </p>
          <p className="mt-1 text-sm">Email reminders: {m.emailReminders ? 'On' : 'Off'}</p>
        </Card>
        <Card title="Orders">
          <ul className="divide-y divide-gray-100 text-sm">
            {m.orders.map((o: any) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{formatDateTime(o.createdAt)} · {o.planNameSnapshot} · {formatNgn(o.amountKobo)} · <span className="font-mono text-xs">{o.reference}</span> {o.isDemo && <DemoBadge />}</span>
                <OrderBadge value={o.status} />
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Access tasks">
          <ul className="divide-y divide-gray-100 text-sm">
            {m.accessTasks.map((t: any) => (
              <li key={t.id} className="flex justify-between gap-2 py-2"><span>{TASK_TYPE_LABELS[t.type]} · {formatDateTime(t.createdAt)}</span><Badge>{t.status}</Badge></li>
            ))}
            {!m.accessTasks.length && <li className="py-2 text-gray-600">None</li>}
          </ul>
        </Card>
        <Card title="Messages">
          <ul className="divide-y divide-gray-100 text-sm">
            {m.notifications.map((n: any) => (
              <li key={n.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>{n.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email'} · {n.type.replace(/_/g, ' ').toLowerCase()} · {formatDateTime(n.sentAt ?? n.scheduledFor)}{n.suppressedReason && <span className="text-gray-500"> · {n.suppressedReason}</span>}</span>
                <NotificationBadge value={n.status} />
              </li>
            ))}
            {!m.notifications.length && <li className="py-2 text-gray-600">None</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}
