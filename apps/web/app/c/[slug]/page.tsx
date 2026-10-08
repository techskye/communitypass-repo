import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatNgn, PLAN_DURATION_LABELS, PlanDurationDays } from '@communitypass/shared';
import { serverApi } from '@/lib/server';

interface PublicCommunity {
  name: string;
  slug: string;
  description: string;
  imageUrl: string | null;
  gracePeriodDays: number;
  creator: { displayName: string; supportEmail: string };
  plans: { id: string; name: string; description: string | null; priceKobo: number; durationDays: number }[];
  checkoutAvailable: boolean;
  checkoutUnavailableReason: string | null;
  isDemoCheckout: boolean;
}

async function load(slug: string): Promise<PublicCommunity | null> {
  try {
    return await serverApi<PublicCommunity>(`/api/public/communities/${encodeURIComponent(slug)}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const c = await load((await params).slug);
  return { title: c ? `${c.name} by ${c.creator.displayName}` : 'Community not found' };
}

export default async function CommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const c = await load((await params).slug);
  if (!c) notFound();
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {c.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.imageUrl} alt="" className="h-48 w-full object-cover" />
        )}
        <div className="p-5">
          <p className="text-sm text-gray-600">A WhatsApp community by {c.creator.displayName}</p>
          <h1 className="mt-1 text-2xl font-bold">{c.name}</h1>
          {c.description && <p className="mt-3 whitespace-pre-line text-gray-700">{c.description}</p>}
        </div>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Choose a plan</h2>
      {!c.checkoutAvailable && (
        <p role="status" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {c.checkoutUnavailableReason}
        </p>
      )}
      <ul className="mt-3 space-y-3">
        {c.plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
            <div>
              <p className="font-semibold">{p.name}</p>
              <p className="text-sm text-gray-600">
                {PLAN_DURATION_LABELS[p.durationDays as PlanDurationDays] ?? `${p.durationDays} days`} of access · one-time payment, no auto-renewal
              </p>
              {p.description && <p className="mt-1 text-sm text-gray-600">{p.description}</p>}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold">{formatNgn(p.priceKobo)}</span>
              {c.checkoutAvailable ? (
                <Link href={`/c/${c.slug}/join?plan=${p.id}`} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">
                  Join
                </Link>
              ) : (
                <span className="rounded-lg bg-gray-200 px-4 py-2 text-gray-500">Unavailable</span>
              )}
            </div>
          </li>
        ))}
        {!c.plans.length && <li className="text-gray-600">No plans are available right now.</li>}
      </ul>

      <section className="mt-8 space-y-2 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700">
        <h2 className="font-semibold text-gray-900">What happens after you pay</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Your payment is confirmed with Paystack{c.isDemoCheckout ? ' (simulated in demo mode)' : ''}.</li>
          <li>Sign in to your member page with your email to see how to join the WhatsApp group.</li>
          <li>{c.creator.displayName} approves new members in WhatsApp manually, so joining can take a little while.</li>
          {c.gracePeriodDays > 0 && <li>If your paid time ends, you have a {c.gracePeriodDays}-day grace period to renew before you may be removed.</li>}
        </ol>
        <p>
          Already a member? <Link href="/member/login" className="text-brand-700 underline">Sign in</Link>. Questions? Email{' '}
          <a href={`mailto:${c.creator.supportEmail}`} className="text-brand-700 underline">{c.creator.supportEmail}</a>.
        </p>
      </section>
    </main>
  );
}
