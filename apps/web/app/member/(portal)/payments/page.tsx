'use client';

import { formatDateTime, formatNgn } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { DemoBadge, ErrorAlert, Loading, OrderBadge, PageHeader, PaymentBadge, ResponsiveTable, Empty } from '@/components/ui';

export default function MyPayments() {
  const { data, error, loading, reload } = useApi<any[]>('/member/payments');
  return (
    <>
      <PageHeader title="Payment history" subtitle="Payments are confirmed with Paystack before your membership is updated." />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <ResponsiveTable
          rows={data}
          rowKey={(r) => r.reference}
          empty={<Empty title="No payments yet" />}
          columns={[
            { header: 'Community', primary: true, cell: (r) => <>{r.community} <span className="text-sm font-normal text-gray-500">· {r.creator}</span></> },
            { header: 'Plan', cell: (r) => `${r.plan} (${r.durationDays} days)` },
            { header: 'Amount', cell: (r) => <>{formatNgn(r.amountKobo)} {r.isDemo && <DemoBadge />}</> },
            { header: 'Date', cell: (r) => formatDateTime(r.paidAt ?? r.createdAt) },
            { header: 'Status', cell: (r) => (r.paymentStatus ? <PaymentBadge value={r.paymentStatus} /> : <OrderBadge value={r.orderStatus} />) },
            { header: 'Reference', cell: (r) => <span className="font-mono text-xs">{r.reference}</span> },
          ]}
        />
      )}
    </>
  );
}
