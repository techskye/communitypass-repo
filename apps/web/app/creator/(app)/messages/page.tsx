'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { formatDateTime } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Button, cx, Empty, ErrorAlert, Loading, NotificationBadge, PageHeader, Pager, ResponsiveTable } from '@/components/ui';
import { useMe } from '@/components/me-context';

const TYPE_LABEL: Record<string, string> = {
  PAYMENT_RECEIPT: 'Payment receipt',
  ACCESS_INSTRUCTIONS: 'Access instructions',
  RENEWAL_REMINDER: 'Renewal reminder',
  EXPIRY_NOTICE: 'Expiry notice',
  GRACE_ENDED: 'Grace period ended',
  CREATOR_DIGEST: 'Daily digest (to you)',
};

function Messages() {
  const me = useMe();
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [channel, setChannel] = useState('');
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<ApiError | null>(null);
  const qs = new URLSearchParams({ page: String(page), ...(status ? { status } : {}), ...(channel ? { type: channel } : {}) });
  const { data, error, loading, reload } = useApi<any>(`/org/notifications?${qs}`);
  async function retry(id: string) {
    if (!confirm('Only re-send if you have checked the member did not receive the first message. Re-send now?')) return;
    try {
      await api(`/org/notifications/${id}/retry`, { body: {} });
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  }
  return (
    <>
      <PageHeader title="Message history" subtitle="Receipts, reminders and notices sent to your members. “Not sent (skipped)” usually means the member opted out or renewed." />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter messages">
        {[['', 'All'], ['DELIVERED', 'Delivered'], ['SENT', 'Sent'], ['SCHEDULED', 'Scheduled'], ['FAILED', 'Failed'], ['NEEDS_REVIEW', 'Needs review'], ['SUPPRESSED', 'Skipped']].map(([v, l]) => (
          <button key={v} onClick={() => { setStatus(v); setPage(1); }} aria-pressed={status === v} className={cx('rounded-full px-3 py-1 text-sm', status === v ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white')}>{l}</button>
        ))}
        <select aria-label="Channel" value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }} className="rounded-full border border-gray-300 bg-white px-3 py-1 text-sm">
          <option value="">All channels</option>
          <option value="WHATSAPP">WhatsApp</option>
          <option value="EMAIL">Email</option>
        </select>
      </div>
      <ErrorAlert error={err} />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && (
        <ResponsiveTable
          rows={data.items}
          rowKey={(r: any) => r.id}
          empty={<Empty title="No messages yet" />}
          columns={[
            { header: 'Message', primary: true, cell: (r: any) => `${TYPE_LABEL[r.type] ?? r.type}${r.member ? ` → ${r.member.fullName}` : ''}` },
            { header: 'Channel', cell: (r: any) => (r.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email') },
            { header: 'When', cell: (r: any) => formatDateTime(r.sentAt ?? r.scheduledFor) },
            { header: 'Status', cell: (r: any) => <NotificationBadge value={r.status} /> },
            { header: 'Details', cell: (r: any) => <span className="text-xs text-gray-600">{r.suppressedReason ?? r.lastError ?? (r.attemptCount > 1 ? `${r.attemptCount} attempts` : '')}</span> },
            {
              header: '',
              cell: (r: any) =>
                me.role === 'OWNER' && ['FAILED', 'NEEDS_REVIEW'].includes(r.status) && r.type !== 'CREATOR_DIGEST' ? (
                  <Button size="sm" variant="secondary" onClick={() => retry(r.id)}>Re-send</Button>
                ) : null,
            },
          ]}
        />
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}

export default function MessagesPage() {
  return <Suspense fallback={<Loading />}><Messages /></Suspense>;
}
