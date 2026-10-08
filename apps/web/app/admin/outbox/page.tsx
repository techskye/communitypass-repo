'use client';

import { formatDateTime } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { Alert, Badge, Empty, ErrorAlert, Loading, PageHeader } from '@/components/ui';

export default function Outbox() {
  const { data, error, loading, reload } = useApi<any[]>('/admin/demo-outbox');
  return (
    <>
      <PageHeader title="Demo outbox" subtitle="Messages the mock WhatsApp and email adapters would have sent in demo mode." />
      <Alert kind="info">Nothing here was really sent. In live mode this list is empty. Sign-in tokens are redacted.</Alert>
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && !data.length && <div className="mt-4"><Empty title="No demo messages yet">The worker sends queued messages every 30 seconds.</Empty></div>}
      <ul className="mt-4 space-y-3">
        {data?.map((m) => (
          <li key={m.id} className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><Badge color={m.channel === 'WHATSAPP' ? 'green' : 'blue'}>{m.channel}</Badge> to {m.recipient}{m.meta?.template && <> · template <span className="font-mono">{m.meta.template}</span></>}</span>
              <span className="text-gray-500">{formatDateTime(m.createdAt)}</span>
            </div>
            {m.subject && <p className="mt-2 font-medium">{m.subject}</p>}
            <p className="mt-1 whitespace-pre-line text-gray-700">{m.body}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
