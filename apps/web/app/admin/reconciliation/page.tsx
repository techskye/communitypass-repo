'use client';

import { useState } from 'react';
import { formatDateTime } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Badge, Button, cx, Empty, ErrorAlert, Loading, PageHeader } from '@/components/ui';

export default function Reconciliation() {
  const [status, setStatus] = useState('OPEN');
  const { data, error, loading, reload } = useApi<any[]>(`/admin/reconciliation?status=${status}`);
  const [err, setErr] = useState<ApiError | null>(null);
  async function resolve(id: string) {
    const resolution = prompt('How was this resolved? (recorded in the audit log)');
    if (!resolution) return;
    try {
      await api(`/admin/reconciliation/${id}/resolve`, { body: { resolution } });
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  }
  return (
    <>
      <PageHeader title="Payment reconciliation issues" subtitle="Mismatched amounts/currency/subaccount, unknown references, refunds and disputes. Entitlement changes are made by the creator via review tasks." />
      <div className="mb-4 flex gap-2">
        {['OPEN', 'RESOLVED'].map((s) => <button key={s} onClick={() => setStatus(s)} aria-pressed={status === s} className={cx('rounded-full px-3 py-1 text-sm', status === s ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white')}>{s.toLowerCase()}</button>)}
      </div>
      <ErrorAlert error={err} />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && !data.length && <Empty title="No issues" />}
      <ul className="space-y-3">
        {data?.map((i) => (
          <li key={i.id} className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><Badge color="red">{i.kind}</Badge> {i.organization?.displayName ?? 'Unknown organization'} · <span className="font-mono">{i.reference}</span></span>
              <span className="text-gray-500">{formatDateTime(i.createdAt)}</span>
            </div>
            <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-2 text-xs">{JSON.stringify(i.details, null, 2)}</pre>
            {i.status === 'OPEN' ? <Button size="sm" className="mt-2" onClick={() => resolve(i.id)}>Mark resolved</Button> : <p className="mt-2 text-gray-600">Resolved: {i.resolution}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
