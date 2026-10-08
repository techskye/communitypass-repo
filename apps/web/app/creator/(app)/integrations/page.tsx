'use client';

import { useApi } from '@/lib/api';
import { Alert, Badge, Card, ErrorAlert, Loading, PageHeader } from '@/components/ui';

const SETUP_LABEL: Record<string, [string, 'green' | 'amber' | 'red' | 'gray']> = {
  NOT_CONFIGURED: ['Not set up', 'gray'],
  PENDING_REVIEW: ['Under review', 'amber'],
  ACTIVE: ['Active', 'green'],
  SUSPENDED: ['Suspended', 'red'],
};

export default function Integrations() {
  const { data, error, loading, reload } = useApi<any>('/org/integrations');
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const p = data.payments;
  const [label, color] = SETUP_LABEL[p.setupStatus] ?? [p.setupStatus, 'gray'];
  return (
    <>
      <PageHeader title="Integrations" />
      <div className="space-y-4">
        {data.appMode === 'demo' && <Alert kind="info">Demo mode: all providers are simulated.</Alert>}
        <Card title="Payments (Paystack)" actions={<Badge color={color}>{label}</Badge>}>
          <div className="space-y-2 text-sm">
            <p>Members pay on Paystack&apos;s hosted checkout. Your share is settled by Paystack to your own bank account through a payout (sub)account set up by the CommunityPass team. You never paste secret keys into CommunityPass.</p>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div><dt className="text-gray-500">Payout account</dt><dd>{p.subaccountConfigured ? `${p.subaccountCodeMasked}${p.settlementBankName ? ` · ${p.settlementBankName}` : ''}${p.accountNumberLast4 ? ` ••••${p.accountNumberLast4}` : ''}` : 'Not set up'}</dd></div>
              <div><dt className="text-gray-500">CommunityPass platform fee</dt><dd>{p.platformFeePercent}% of each payment</dd></div>
              <div><dt className="text-gray-500">Paystack fees paid by</dt><dd>{p.feeBearer === 'SUBACCOUNT' ? 'You (deducted from your share)' : p.feeBearer === 'ACCOUNT' ? 'CommunityPass' : '—'}</dd></div>
              <div><dt className="text-gray-500">Checkout</dt><dd>{p.checkoutReady ? 'Accepting payments' : p.checkoutBlockedReason}</dd></div>
            </dl>
            {!p.checkoutReady && <Alert kind="warning">To go live, email the CommunityPass team your business name and settlement bank details. We create your Paystack payout account and switch on payments once Paystack approves the platform for live split payments.</Alert>}
            <p className="text-gray-600">Your CommunityPass subscription is billed separately and is never deducted from member payments.</p>
          </div>
        </Card>
        <Card title="WhatsApp messages" actions={<Badge color={data.whatsapp.enabled ? 'green' : 'gray'}>{data.whatsapp.enabled ? 'On' : 'Off'}</Badge>}>
          <p className="text-sm">Messages are sent from the official CommunityPass WhatsApp Business number on your behalf, only to members who opted in, using Meta-approved templates.</p>
          <ul className="mt-2 space-y-1 text-sm">
            {data.whatsapp.templates.map((t: any) => (
              <li key={t.purpose} className="flex justify-between gap-2"><span>{t.purpose.replace(/_/g, ' ').toLowerCase()} ({t.language})</span><Badge color={t.status === 'APPROVED' ? 'green' : t.status === 'REJECTED' ? 'red' : 'amber'}>{t.status.toLowerCase()}</Badge></li>
            ))}
            {!data.whatsapp.templates.length && <li className="text-gray-600">No templates configured yet — WhatsApp messages are paused until templates are approved.</li>}
          </ul>
          <p className="mt-2 text-sm text-gray-600">Group access is not automated. CommunityPass does not add or remove anyone from WhatsApp groups.</p>
        </Card>
        <Card title="Email" actions={<Badge color={data.email.enabled ? 'green' : 'gray'}>{data.email.enabled ? 'On' : 'Off'}</Badge>}>
          <p className="text-sm">Receipts, sign-in links and reminders are sent by CommunityPass via Resend.</p>
        </Card>
      </div>
    </>
  );
}
