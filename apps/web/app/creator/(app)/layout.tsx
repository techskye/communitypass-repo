'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api, useApi } from '@/lib/api';
import { Badge, cx, Loading } from '@/components/ui';
import { Me, MeContext } from '@/components/me-context';


const NAV: [string, string][] = [
  ['/creator', 'Dashboard'],
  ['/creator/tasks', 'Access tasks'],
  ['/creator/members', 'Members'],
  ['/creator/payments', 'Payments'],
  ['/creator/communities', 'Communities'],
  ['/creator/plans', 'Plans'],
  ['/creator/reminders', 'Reminders'],
  ['/creator/messages', 'Messages'],
  ['/creator/staff', 'Team'],
  ['/creator/integrations', 'Integrations'],
  ['/creator/settings', 'Settings'],
];

export default function CreatorLayout({ children }: { children: React.ReactNode }) {
  const { data: me, error, loading } = useApi<Me>('/auth/me');
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (error?.status === 401) router.replace('/creator/login');
    if (me && !me.activeOrganizationId) router.replace(me.user.isPlatformAdmin ? '/admin' : '/creator/onboarding');
  }, [error, me, router]);
  if (loading || !me || !me.activeOrganizationId) return <main className="mx-auto max-w-6xl px-4"><Loading /></main>;
  const org = me.organizations.find((o) => o.id === me.activeOrganizationId);

  return (
    <MeContext.Provider value={me}>
      <div className="mx-auto max-w-6xl px-4">
        <header className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-2">
            <Link href="/creator" className="text-lg font-bold text-brand-700">CommunityPass</Link>
            <span className="text-gray-400">/</span>
            {me.organizations.length > 1 ? (
              <select
                aria-label="Switch organization"
                className="rounded border border-gray-300 bg-white px-2 py-1 text-sm"
                value={me.activeOrganizationId}
                onChange={async (e) => {
                  await api('/auth/switch-org', { body: { organizationId: e.target.value } });
                  window.location.reload();
                }}
              >
                {me.organizations.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
              </select>
            ) : (
              <span className="font-medium">{org?.displayName}</span>
            )}
            {org?.isDemo && <Badge color="purple">Demo data</Badge>}
            {org?.status === 'SUSPENDED' && <Badge color="red">Suspended</Badge>}
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-600">
            <span className="hidden sm:inline">{me.user.name} · {me.role === 'OWNER' ? 'Owner' : 'Staff'}</span>
            {me.user.isPlatformAdmin && <Link href="/admin" className="underline">Admin</Link>}
            <button
              className="rounded-lg px-2 py-1 hover:bg-gray-100"
              onClick={async () => {
                await api('/auth/logout', { body: {} });
                router.replace('/creator/login');
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <div className="md:grid md:grid-cols-[200px_1fr] md:gap-6">
          <nav aria-label="Creator" className="-mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-gray-200 px-4 md:mx-0 md:block md:space-y-1 md:border-0 md:px-0">
            {NAV.map(([href, label]) => {
              const active = href === '/creator' ? path === href : path.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'block whitespace-nowrap px-3 py-2 text-sm font-medium md:rounded-lg',
                    active ? 'border-b-2 border-brand-600 text-brand-700 md:border-0 md:bg-brand-50' : 'text-gray-700 hover:text-gray-900 md:hover:bg-gray-100',
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </MeContext.Provider>
  );
}
