'use client';

import Link from 'next/link';
import { formatNgn } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { Alert, Card, ErrorAlert, Loading, PageHeader, Stat } from '@/components/ui';

export default function Dashboard() {
  const { data, error, loading, reload } = useApi<any>('/org/dashboard');
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const m = data.metrics;
  return (
    <>
      <PageHeader title={`Welcome, ${data.organization.displayName}`} subtitle="All figures come from confirmed records in CommunityPass." />
      {!data.payments.ready && (
        <div className="mb-4">
          <Alert kind="warning" title="Payments are not live yet">
            {data.payments.reason}. The CommunityPass team sets up your Paystack payout account; see <Link href="/creator/integrations" className="underline">Integrations</Link>.
          </Alert>
        </div>
      )}
      {m.collections.includesDemoPayments && (
        <div className="mb-4">
          <Alert kind="info">These figures include demo payments. Demo payments are simulated and involve no real money.</Alert>
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">To do</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/creator/tasks?type=GRANT"><Stat label="Members to add" value={m.tasks.pendingGrant} tone={m.tasks.pendingGrant ? 'warn' : undefined} /></Link>
        <Link href="/creator/tasks?type=REMOVE"><Stat label="Expired members to remove" value={m.tasks.pendingRemoval} tone={m.tasks.pendingRemoval ? 'warn' : undefined} /></Link>
        <Link href="/creator/tasks?type=REVIEW"><Stat label="Payments to review" value={m.tasks.pendingReview} tone={m.tasks.pendingReview ? 'bad' : undefined} /></Link>
        <Link href="/creator/messages?status=FAILED"><Stat label="Message failures (30 days)" value={m.notificationFailures30Days} tone={m.notificationFailures30Days ? 'bad' : undefined} /></Link>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Memberships</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/creator/members?status=active"><Stat label="Active paid" value={m.memberships.activePaid} /></Link>
        <Link href="/creator/members?status=expiring"><Stat label="Ending in 7 days" value={m.memberships.expiringIn7Days} /></Link>
        <Link href="/creator/members?status=grace"><Stat label="In grace period" value={m.memberships.inGracePeriod} hint="Not paid; temporary access" /></Link>
        <Link href="/creator/members?status=expired"><Stat label="Expired" value={m.memberships.expired} /></Link>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Collections</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Gross collections (30 days)" value={formatNgn(m.collections.last30DaysKobo)} hint={`${m.collections.last30DaysCount} payments`} />
        <Stat label="Gross collections (all time)" value={formatNgn(m.collections.allTimeKobo)} hint={`${m.collections.allTimeCount} payments`} />
        <Stat label="Refunds" value={formatNgn(m.refunds.totalKobo)} hint={`${m.refunds.count} refunded payments`} />
        <Stat label="Held for review" value={m.paymentsHeldForReview} tone={m.paymentsHeldForReview ? 'bad' : undefined} />
      </div>
      <p className="mb-6 text-sm text-gray-500">
        “Collections” are successful payments confirmed by Paystack. They are not your settled bank balance — settlement timing and fees are shown in your Paystack dashboard.
      </p>

      <Card title="Your public pages">
        <ul className="space-y-1 text-sm">
          {data.communities.map((c: any) => (
            <li key={c.id}>
              {c.name}: <Link href={`/c/${c.slug}`} className="text-brand-700 underline" target="_blank">/c/{c.slug}</Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
