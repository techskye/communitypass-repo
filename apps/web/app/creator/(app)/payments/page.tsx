'use client';

import { useState } from 'react';
import { formatDateTime, formatNgn } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { cx, DemoBadge, Empty, ErrorAlert, Loading, OrderBadge, PageHeader, Pager, PaymentBadge, ResponsiveTable } from '@/components/ui';

export default function Payments() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...(status ? { status } : {}) });
  const { data, error, loading, reload } = useApi<any>(`/org/payments?${qs}`);
  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Every checkout attempt. Only payments confirmed by Paystack extend memberships."
        actions={<a href="/api/org/payments.csv" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">Export CSV</a>}
      />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter payments">
        {[['', 'All'], ['PAID', 'Paid'], ['PENDING', 'Awaiting payment'], ['NEEDS_REVIEW', 'Needs review'], ['FAILED', 'Failed'], ['ABANDONED', 'Not completed']].map(([v, l]) => (
          <button key={v} onClick={() => { setStatus(v); setPage(1); }} aria-pressed={status === v} className={cx('rounded-full px-3 py-1 text-sm', status === v ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white')}>{l}</button>
        ))}
      </div>
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <ResponsiveTable
          rows={data.items}
          rowKey={(r: any) => r.id}
          empty={<Empty title="No payments yet" />}
          columns={[
            { header: 'Member', primary: true, cell: (r: any) => r.member.fullName },
            { header: 'Plan', cell: (r: any) => `${r.communityNameSnapshot} · ${r.planNameSnapshot} (${r.durationDays} days)` },
            { header: 'Amount', cell: (r: any) => <>{formatNgn(r.amountKobo)} {r.isDemo && <DemoBadge />}</> },
            { header: 'Date', cell: (r: any) => formatDateTime(r.payment?.paidAt ?? r.createdAt) },
            { header: 'Status', cell: (r: any) => (r.payment ? <PaymentBadge value={r.payment.status} /> : <OrderBadge value={r.status} />) },
            { header: 'Paid time', cell: (r: any) => (r.application ? `→ ${formatDateTime(r.application.newPaidUntil)}` : '—') },
            { header: 'Reference', cell: (r: any) => <span className="font-mono text-xs">{r.reference}</span> },
          ]}
        />
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
