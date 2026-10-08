'use client';

import { formatDateTime } from '@communitypass/shared';
import { api, useApi } from '@/lib/api';
import { Button, Card, Empty, ErrorAlert, Loading, NotificationBadge, PageHeader } from '@/components/ui';

export default function Jobs() {
  const { data, error, loading, reload } = useApi<any>('/admin/jobs');
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  return (
    <>
      <PageHeader title="Failed jobs" subtitle="Dead-lettered queue jobs, failed or ambiguous message sends, and webhook events awaiting processing." />
      <div className="space-y-4">
        <Card title="Queue failures">
          {data.queueFailures.length ? (
            <ul className="divide-y divide-gray-100 text-sm">
              {data.queueFailures.map((j: any) => (
                <li key={`${j.queue}-${j.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-mono">{j.queue}/{j.name}#{j.id}</span> · {j.attemptsMade} attempts · {j.failedReason}</span>
                  {j.id && <Button size="sm" variant="secondary" onClick={async () => { await api(`/admin/jobs/${j.queue}/${j.id}/retry`, { body: {} }); await reload(); }}>Retry</Button>}
                </li>
              ))}
            </ul>
          ) : <Empty title="No failed queue jobs" />}
        </Card>
        <Card title="Messages failed or needing review">
          {data.notifications.length ? (
            <ul className="divide-y divide-gray-100 text-sm">
              {data.notifications.map((n: any) => (
                <li key={n.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{n.channel} · {n.type} · {n.attemptCount} attempts · {formatDateTime(n.updatedAt)} · {n.lastError}</span>
                  <NotificationBadge value={n.status} />
                </li>
              ))}
            </ul>
          ) : <Empty title="None" />}
          <p className="mt-2 text-sm text-gray-600">“Needs review” means the provider may or may not have delivered it. These are never re-sent automatically; creators can re-send after checking.</p>
        </Card>
        <Card title="Unprocessed webhook events">
          {data.unprocessedEvents.length ? (
            <ul className="divide-y divide-gray-100 text-sm">
              {data.unprocessedEvents.map((e: any) => <li key={e.id} className="py-2">{e.source} · {e.eventType} · {e.attempts} attempts · {formatDateTime(e.receivedAt)} {e.processingError && `· ${e.processingError}`}</li>)}
            </ul>
          ) : <Empty title="All webhook events processed" />}
        </Card>
      </div>
    </>
  );
}
