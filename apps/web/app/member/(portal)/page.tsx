'use client';

import Link from 'next/link';
import { formatDateTime } from '@communitypass/shared';
import { useApi } from '@/lib/api';
import { AccessBadge, Empty, EntitlementBadge, ErrorAlert, Loading, PageHeader } from '@/components/ui';

export default function MyMemberships() {
  const { data, error, loading, reload } = useApi<any[]>('/member/memberships');
  return (
    <>
      <PageHeader title="My memberships" />
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && !data.length && <Empty title="No memberships yet">When you join a community, it will appear here.</Empty>}
      <ul className="space-y-3">
        {data?.map((m) => (
          <li key={m.id}>
            <Link href={`/member/memberships/${m.id}`} className="block rounded-xl border border-gray-200 bg-white p-4 hover:border-brand-500">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{m.community.name}</p>
                  <p className="text-sm text-gray-600">by {m.creator.displayName} · {m.plan.name}</p>
                </div>
                <EntitlementBadge value={m.entitlement} />
              </div>
              <p className="mt-2 text-sm text-gray-700">
                {m.entitlement === 'active' && <>Paid until <strong>{formatDateTime(m.paidUntil)}</strong></>}
                {m.entitlement === 'grace' && <>Expired {formatDateTime(m.paidUntil)} — grace period until <strong>{formatDateTime(m.graceEndsAt)}</strong>. Renew to keep your place.</>}
                {m.entitlement === 'expired' && <>Expired on {formatDateTime(m.paidUntil)}</>}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                <AccessBadge value={m.accessStatus} />
                {m.cancelled && <span className="text-gray-500">Not renewing</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
