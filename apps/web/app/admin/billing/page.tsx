'use client';

import Link from 'next/link';
import { SUBSCRIPTION_ACCESS_LABELS, formatDate, formatNgn } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { Badge, ErrorAlert, Loading, PageHeader, ResponsiveTable, Stat } from '@/components/ui';

const COLOR: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = {
  trialing: 'blue', active: 'green', past_due: 'amber', paused: 'red', cancelled: 'gray',
};

export default function AdminBilling() {
  const { data, error, loading, reload } = useApi<any>('/admin/billing');
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const count = (a: string) => data.rows.filter((r: any) => r.access === a).length;
  return (
    <>
      <PageHeader title="Creator billing" subtitle="CommunityPass subscriptions paid by creators (separate from member payments)." />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Monthly recurring (auto-renew)" value={formatNgn(data.mrrKobo)} />
        <Stat label="Collected (30 days)" value={formatNgn(data.collected30DaysKobo)} hint={`${data.collected30DaysCount} payments`} />
        <Stat label="Trialing" value={count('trialing')} />
        <Stat label="Overdue" value={count('past_due')} tone={count('past_due') ? 'warn' : undefined} />
        <Stat label="Paused / cancelled" value={count('paused') + count('cancelled')} tone={count('paused') ? 'bad' : undefined} />
      </div>
      <ResponsiveTable
        rows={data.rows}
        rowKey={(r: any) => r.organization.id}
        columns={[
          { header: 'Creator', primary: true, cell: (r: any) => <Link className="text-brand-700 underline" href={`/admin/orgs/${r.organization.id}`}>{r.organization.displayName}</Link> },
          { header: 'Plan', cell: (r: any) => `${r.tier}${r.pendingTier ? ` → ${r.pendingTier}` : ''}` },
          { header: 'Status', cell: (r: any) => <Badge color={COLOR[r.access]}>{SUBSCRIPTION_ACCESS_LABELS[r.access as keyof typeof SUBSCRIPTION_ACCESS_LABELS]}</Badge> },
          { header: 'Paid / trial until', cell: (r: any) => formatDate(r.paidThrough) },
          { header: 'Auto-renew', cell: (r: any) => (r.autoRenew ? 'On' : 'Off') },
          { header: 'Last invoice', cell: (r: any) => (r.lastInvoice ? `${r.lastInvoice.status.toLowerCase()} · ${formatNgn(r.lastInvoice.amountKobo)}${r.failedAttempts ? ` · ${r.failedAttempts} failed` : ''}` : '—') },
        ]}
      />
    </>
  );
}
