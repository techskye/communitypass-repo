'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { formatDateTime } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { AccessBadge, cx, Empty, EntitlementBadge, ErrorAlert, Loading, PageHeader, Pager, ResponsiveTable } from '@/components/ui';

function Members() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get('status') ?? '';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...(status ? { status } : {}), ...(sp.get('q') ? { q: sp.get('q')! } : {}) });
  const { data, error, loading, reload } = useApi<any>(`/org/members?${qs}`);
  const go = (next: Record<string, string>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) (v ? n.set(k, v) : n.delete(k));
    setPage(1);
    router.replace(`/creator/members?${n}`);
  };
  return (
    <>
      <PageHeader title="Members" actions={<a href="/api/org/members.csv" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">Export CSV</a>} />
      <form onSubmit={(e) => { e.preventDefault(); go({ q }); }} className="mb-3 flex gap-2">
        <label htmlFor="member-search" className="sr-only">Search members</label>
        <input id="member-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        <button className="rounded-lg bg-brand-600 px-4 py-2 text-white">Search</button>
      </form>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {[['', 'All'], ['active', 'Active'], ['expiring', 'Ending in 7 days'], ['grace', 'Grace'], ['expired', 'Expired']].map(([v, l]) => (
          <button key={v} onClick={() => go({ status: v })} aria-pressed={status === v} className={cx('rounded-full px-3 py-1 text-sm', status === v ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white')}>{l}</button>
        ))}
      </div>
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <ResponsiveTable
          rows={data.items}
          rowKey={(r: any) => r.membershipId}
          empty={<Empty title="No members found">Share your community link to get your first members.</Empty>}
          columns={[
            { header: 'Member', primary: true, cell: (r: any) => <Link className="text-brand-700 underline" href={`/creator/members/${r.memberId}`}>{r.name}</Link> },
            { header: 'WhatsApp', cell: (r: any) => <span className="font-mono">{r.phone}</span> },
            { header: 'Community', cell: (r: any) => `${r.community} · ${r.plan}` },
            { header: 'Paid until', cell: (r: any) => formatDateTime(r.paidUntil) },
            { header: 'Status', cell: (r: any) => <EntitlementBadge value={r.entitlement} /> },
            { header: 'Group access', cell: (r: any) => <AccessBadge value={r.accessStatus} /> },
          ]}
        />
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}

export default function MembersPage() {
  return <Suspense fallback={<Loading />}><Members /></Suspense>;
}
