import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { serverApi } from '@/lib/server';

export const metadata: Metadata = {
  title: { default: 'CommunityPass', template: '%s · CommunityPass' },
  description: 'Paid WhatsApp community memberships for Nigerian creators.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#16a34a' };

async function DemoBanner() {
  const cfg = await serverApi<{ appMode: string }>('/api/public/config').catch(() => null);
  if (cfg?.appMode !== 'demo') return null;
  return (
    <div role="note" className="bg-purple-700 px-4 py-2 text-center text-sm font-medium text-white">
      DEMO MODE — payments and messages are simulated. No real money moves and no real WhatsApp or email messages are sent.
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <DemoBanner />
        <div id="main">{children}</div>
        <footer className="mx-auto mt-16 max-w-5xl px-4 pb-10 text-sm text-gray-500">
          <div className="flex flex-wrap gap-4 border-t border-gray-200 pt-6">
            <span>© CommunityPass</span>
            <Link href="/privacy" className="hover:underline">
              Privacy
            </Link>
            <Link href="/terms" className="hover:underline">
              Membership terms
            </Link>
            <Link href="/member/login" className="hover:underline">
              Member sign-in
            </Link>
            <Link href="/creator/login" className="hover:underline">
              Creator sign-in
            </Link>
          </div>
          <p className="mt-3">
            CommunityPass manages memberships and reminders. It is not affiliated with WhatsApp or Meta and does not control WhatsApp groups.
          </p>
        </footer>
      </body>
    </html>
  );
}
