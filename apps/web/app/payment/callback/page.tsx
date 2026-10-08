'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { formatDateTime, formatNgn } from '@communitypass/shared';
import { api, ApiError } from '@/lib/api';
import { Alert, Card, DemoBadge, LinkButton, Loading, Spinner } from '@/components/ui';

interface OrderStatus {
  reference: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'ABANDONED' | 'NEEDS_REVIEW';
  isDemo: boolean;
  communityName: string;
  communitySlug: string;
  planName: string;
  amountKobo: number;
  paidUntil: string | null;
}

/**
 * The redirect from the payment page only tells us which order to check. Activation happens
 * only after the server verifies the payment with the provider (or receives a signed webhook).
 */
function Callback() {
  const params = useSearchParams();
  const reference = params.get('reference') ?? params.get('trxref');
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!reference || !/^CP-[A-Z0-9]{16}$/.test(reference)) {
      setError('This payment link is not valid.');
      return;
    }
    let cancelled = false;
    async function poll(n: number) {
      try {
        const o = await api<OrderStatus>(`/public/orders/${reference}/verify`, { method: 'POST', body: {} });
        if (cancelled) return;
        setOrder(o);
        setAttempts(n);
        if (o.status === 'PENDING' && n < 20) timer.current = setTimeout(() => poll(n + 1), Math.min(2000 + n * 1000, 8000));
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not check your payment.');
      }
    }
    void poll(0);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [reference]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!order) return <Loading label="Checking your payment…" />;

  return (
    <Card>
      <div className="flex items-center gap-2 text-sm text-gray-600">
        {order.communityName} · {order.planName} · {formatNgn(order.amountKobo)} {order.isDemo && <DemoBadge />}
      </div>
      {order.status === 'PAID' && (
        <div className="mt-3 space-y-3">
          <h2 className="text-xl font-bold text-brand-700">Payment confirmed 🎉</h2>
          <p>
            Your membership is paid until <strong>{formatDateTime(order.paidUntil)}</strong> (Lagos time).
          </p>
          <p className="text-gray-700">
            Next: sign in to your member page with the email you used to see how to join the WhatsApp group. The creator approves new members manually.
          </p>
          <LinkButton href="/member/login">Go to my member page</LinkButton>
        </div>
      )}
      {order.status === 'PENDING' && (
        <div className="mt-3 space-y-2" aria-live="polite">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Spinner /> Waiting for payment confirmation
          </h2>
          <p className="text-gray-700">
            We only activate memberships once the payment provider confirms the payment. This usually takes a few seconds.
          </p>
          {attempts >= 20 && (
            <Alert kind="warning">
              Still not confirmed. If you completed the payment, it will be confirmed automatically — you&apos;ll receive an email. You can safely close this page. Reference: {order.reference}
            </Alert>
          )}
        </div>
      )}
      {(order.status === 'FAILED' || order.status === 'ABANDONED') && (
        <div className="mt-3 space-y-3">
          <h2 className="text-xl font-bold text-red-700">Payment not completed</h2>
          <p>No membership was activated. You have not been charged for this attempt.</p>
          <LinkButton href={`/c/${order.communitySlug}`}>Try again</LinkButton>
        </div>
      )}
      {order.status === 'NEEDS_REVIEW' && (
        <div className="mt-3 space-y-2">
          <h2 className="text-xl font-bold text-amber-700">We need to check this payment</h2>
          <p>
            Something about this payment didn&apos;t match what we expected, so it&apos;s being reviewed. Please contact the creator with your reference: <strong>{order.reference}</strong>.
          </p>
        </div>
      )}
    </Card>
  );
}

export default function CallbackPage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-4 text-2xl font-bold">Payment status</h1>
      <Suspense fallback={<Loading />}>
        <Callback />
      </Suspense>
      <p className="mt-6 text-center text-sm text-gray-500">
        <Link href="/" className="underline">CommunityPass</Link>
      </p>
    </main>
  );
}
