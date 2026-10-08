'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api, useApi } from '@/lib/api';
import { cx, Loading } from '@/components/ui';

const NAV = [
  ['/member', 'My memberships'],
  ['/member/payments', 'Payments'],
  ['/member/preferences', 'Notifications'],
];

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  const { data, error, loading } = useApi<{ email: string }>('/member/me');
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (error?.status === 401) router.replace('/member/login');
  }, [error, router]);
  if (loading || !data) return <main className="mx-auto max-w-3xl px-4"><Loading /></main>;
  return (
    <div className="mx-auto max-w-3xl px-4">
      <header className="flex flex-wrap items-center justify-between gap-2 py-4">
        <Link href="/member" className="text-lg font-bold text-brand-700">CommunityPass</Link>
        <div className="flex items-center gap-3 text-sm text-gray-600">
          <span className="hidden sm:inline">{data.email}</span>
          <button
            className="rounded-lg px-2 py-1 hover:bg-gray-100"
            onClick={async () => {
              await api('/member/auth/logout', { body: {} });
              router.replace('/member/login');
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-200" aria-label="Member">
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} aria-current={path === href ? 'page' : undefined} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', path === href ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-600 hover:text-gray-900')}>
            {label}
          </Link>
        ))}
      </nav>
      <main>{children}</main>
    </div>
  );
}
