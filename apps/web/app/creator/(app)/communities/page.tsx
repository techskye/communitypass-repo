'use client';

import Link from 'next/link';
import { useApi } from '@/lib/api';
import { Badge, Card, Empty, ErrorAlert, LinkButton, Loading, PageHeader } from '@/components/ui';
import { useMe } from '@/components/me-context';

export default function Communities() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<any[]>('/org/communities');
  return (
    <>
      <PageHeader title="Communities" actions={me.role === 'OWNER' ? <LinkButton href="/creator/communities/new">New community</LinkButton> : null} />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && !data.length && <Empty title="No communities yet" />}
      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((c) => (
          <Card key={c.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <Link href={`/creator/communities/${c.id}`} className="text-lg font-semibold text-brand-700 underline">{c.name}</Link>
                <p className="text-sm text-gray-600">/c/{c.slug}</p>
              </div>
              {c.isPublished ? <Badge color="green">Published</Badge> : <Badge>Hidden</Badge>}
            </div>
            <p className="mt-2 text-sm text-gray-700">{c.plans.filter((p: any) => p.isActive).length} active plans · {c._count.memberships} memberships · grace {c.gracePeriodDays} days</p>
            {!c.adminApprovalEnabled && <p className="mt-2 text-sm text-amber-800">Tip: turn on “Approve new members” in WhatsApp — invite links can be forwarded.</p>}
          </Card>
        ))}
      </div>
    </>
  );
}
