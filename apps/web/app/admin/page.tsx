'use client';

import Link from 'next/link';
import { formatDate } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { Badge, ErrorAlert, Loading, PageHeader, ResponsiveTable } from '@/components/ui';

export default function AdminOrgs() {
  const { data, error, loading, reload } = useApi<any[]>('/admin/organizations');
  return (
    <>
      <PageHeader title="Organizations" />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <ResponsiveTable
          rows={data}
          rowKey={(o: any) => o.id}
          columns={[
            { header: 'Organization', primary: true, cell: (o: any) => <Link className="text-brand-700 underline" href={`/admin/orgs/${o.id}`}>{o.displayName}</Link> },
            { header: 'Status', cell: (o: any) => <>{o.status === 'ACTIVE' ? <Badge color="green">Active</Badge> : <Badge color="red">Suspended</Badge>} {o.isDemo && <Badge color="purple">Demo</Badge>}</> },
            { header: 'Payments', cell: (o: any) => <Badge color={o.paymentConfig?.status === 'ACTIVE' ? 'green' : 'amber'}>{o.paymentConfig?.status ?? 'NOT_CONFIGURED'}</Badge> },
            { header: 'Fee', cell: (o: any) => `${(o.paymentConfig?.platformFeeBps ?? 0) / 100}%` },
            { header: 'Communities / memberships', cell: (o: any) => `${o._count.communities} / ${o._count.memberships}` },
            { header: 'Created', cell: (o: any) => formatDate(o.createdAt) },
          ]}
        />
      )}
    </>
  );
}
