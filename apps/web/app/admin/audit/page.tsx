'use client';

import { useState } from 'react';
import { formatDateTime } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { ErrorAlert, Loading, PageHeader, ResponsiveTable } from '@/components/ui';

export default function Audit() {
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi<any[]>(`/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of access, payment and configuration changes (latest 200)." />
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); setAction(q); }}>
        <label htmlFor="audit-filter" className="sr-only">Filter by action</label>
        <input id="audit-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by action, e.g. payment" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        <button className="rounded-lg bg-brand-600 px-4 py-2 text-white">Filter</button>
      </form>
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <ResponsiveTable
          rows={data}
          rowKey={(r: any) => r.id}
          columns={[
            { header: 'Action', primary: true, cell: (r: any) => <span className="font-mono text-sm">{r.action}</span> },
            { header: 'When', cell: (r: any) => formatDateTime(r.createdAt) },
            { header: 'Organization', cell: (r: any) => r.organization?.displayName ?? '—' },
            { header: 'Actor', cell: (r: any) => `${r.actorType}${r.actorId ? ` ${r.actorId.slice(-6)}` : ''}` },
            { header: 'Entity', cell: (r: any) => `${r.entityType} ${r.entityId?.slice(-6) ?? ''}` },
            { header: 'Details', cell: (r: any) => <span className="break-all text-xs text-gray-600">{r.metadata ? JSON.stringify(r.metadata).slice(0, 160) : ''}</span> },
          ]}
        />
      )}
    </>
  );
}
