'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api, useApi } from '@/lib/api';
import { cx, Loading } from '@/components/ui';

const NAV: [string, string][] = [
  ['/admin', 'Organizations'],
  ['/admin/integrations', 'Integration health'],
  ['/admin/jobs', 'Failed jobs'],
  ['/admin/reconciliation', 'Reconciliation'],
  ['/admin/audit', 'Audit log'],
  ['/admin/outbox', 'Demo outbox'],
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { data: me, error, loading } = useApi<any>('/auth/me');
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (error?.status === 401) router.replace('/creator/login');
    if (me && !me.user.isPlatformAdmin) router.replace('/creator');
  }, [error, me, router]);
  if (loading || !me?.user.isPlatformAdmin) return <main className="mx-auto max-w-6xl px-4"><Loading /></main>;
  return (
    <div className="mx-auto max-w-6xl px-4">
      <header className="flex items-center justify-between py-4">
        <Link href="/admin" className="text-lg font-bold text-brand-700">CommunityPass <span className="text-gray-500">Admin</span></Link>
        <button className="rounded-lg px-2 py-1 text-sm hover:bg-gray-100" onClick={async () => { await api('/auth/logout', { body: {} }); router.replace('/creator/login'); }}>Sign out</button>
      </header>
      <nav aria-label="Admin" className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-200">
        {NAV.map(([href, label]) => {
          const active = href === '/admin' ? path === href || path.startsWith('/admin/orgs') : path.startsWith(href);
          return <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', active ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-600')}>{label}</Link>;
        })}
      </nav>
      <main>{children}</main>
    </div>
  );
}
