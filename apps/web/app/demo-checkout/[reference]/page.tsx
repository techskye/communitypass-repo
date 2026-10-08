'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatNgn } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { Alert, Button, Card, ErrorAlert, Loading } from '@/components/ui';

/**
 * DEMO PROVIDER CHECKOUT. Stands in for Paystack's hosted checkout in demo mode only.
 * No card details are collected and no money moves.
 */
export default function DemoCheckout() {
  const { reference } = useParams<{ reference: string }>();
  const { data, error, loading } = useApi<any>(`/public/demo-checkout/${reference}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  async function complete(outcome: 'success' | 'failed' | 'wrong_amount') {
    setBusy(outcome);
    setErr(null);
    try {
      await api(`/public/demo-checkout/${reference}/complete`, { body: { outcome } });
      window.location.assign(`/payment/callback?reference=${encodeURIComponent(reference)}`);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="mb-4 rounded-lg border-2 border-dashed border-purple-500 bg-purple-50 p-3 text-sm text-purple-900">
        <strong>Demo payment provider.</strong> This page simulates a hosted checkout. Do not enter card details — there is nowhere to enter them.
      </div>
      {loading && <Loading />}
      <ErrorAlert error={error} />
      {data && (
        <Card title="Demo checkout">
          <p className="text-gray-700">
            {data.communityName} — {data.planName}
          </p>
          <p className="mt-1 text-3xl font-bold">{formatNgn(data.amountKobo)}</p>
          <p className="mt-1 text-sm text-gray-500">Reference {data.reference}</p>
          {data.demoStatus !== 'pending' ? (
            <Alert kind="info">This demo payment was already completed ({data.demoStatus}).</Alert>
          ) : (
            <div className="mt-5 space-y-2">
              <Button className="w-full" loading={busy === 'success'} onClick={() => complete('success')}>
                Simulate successful payment
              </Button>
              <Button className="w-full" variant="secondary" loading={busy === 'failed'} onClick={() => complete('failed')}>
                Simulate failed payment
              </Button>
              <Button className="w-full" variant="secondary" loading={busy === 'wrong_amount'} onClick={() => complete('wrong_amount')}>
                Simulate wrong amount (₦50 short)
              </Button>
            </div>
          )}
          {err && <div className="mt-3"><ErrorAlert error={err} /></div>}
        </Card>
      )}
    </main>
  );
}
