'use client';

import { useApi } from '@/lib/api';
import { PlanRow } from '@/components/plan-editor';
import { Empty, ErrorAlert, Loading, PageHeader } from '@/components/ui';
import { useMe } from '@/components/me-context';

export default function Plans() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<any[]>('/org/plans');
  return (
    <>
      <PageHeader title="Plans" subtitle="Fixed-duration plans: 7, 30, 90 or 365 days. One-time payments; members renew manually. Add plans from a community’s page." />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && !data.length && <Empty title="No plans yet" />}
      <ul className="space-y-2">{data?.map((p) => <PlanRow key={p.id} plan={p} canEdit={me.role === 'OWNER'} onSaved={reload} />)}</ul>
      <p className="mt-4 text-sm text-gray-600">Switching a member between plans while they still have paid time isn&apos;t supported yet. Members renew the plan they have.</p>
    </>
  );
}
