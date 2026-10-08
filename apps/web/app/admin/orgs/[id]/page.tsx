'use client';

import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { formatDate, formatNgn } from '@communitypass/shared';
import { api, ApiError, nairaInputToKobo, useApi } from '@/lib/api';
import { Alert, Badge, Button, Card, ErrorAlert, Field, Loading, PageHeader, Select, Stat } from '@/components/ui';

export default function AdminOrg() {
  const { id } = useParams<{ id: string }>();
  const { data: o, error, loading, reload } = useApi<any>(`/admin/organizations/${id}`);
  const [pc, setPc] = useState<any>(null);
  const [bill, setBill] = useState({ periodStart: '', periodEnd: '', amount: '', status: 'DUE', note: '' });
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (o) setPc({ subaccountCode: o.paymentConfig?.subaccountCode ?? '', settlementBankName: o.paymentConfig?.settlementBankName ?? '', accountNumberLast4: o.paymentConfig?.accountNumberLast4 ?? '', platformFeeBps: o.paymentConfig?.platformFeeBps ?? 0, feeBearer: o.paymentConfig?.feeBearer ?? 'SUBACCOUNT', status: o.paymentConfig?.status === 'NOT_CONFIGURED' ? 'PENDING_REVIEW' : o.paymentConfig?.status ?? 'PENDING_REVIEW', notes: o.paymentConfig?.notes ?? '' });
  }, [o]);
  if (loading || !pc) return error ? <ErrorAlert error={error} onRetry={reload} /> : <Loading />;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  }
  const savePc = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/admin/organizations/${id}/payment-config`, { method: 'PUT', body: { ...pc, accountNumberLast4: pc.accountNumberLast4 || undefined, settlementBankName: pc.settlementBankName || undefined, notes: pc.notes || undefined } }), 'Payment setup saved.');
  };
  const addBill = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/admin/organizations/${id}/billing`, { body: { periodStart: bill.periodStart, periodEnd: bill.periodEnd, amountKobo: nairaInputToKobo(bill.amount || '0'), status: bill.status, note: bill.note || undefined } }), 'Billing record added.');
  };
  const m = o.metrics;
  return (
    <>
      <PageHeader title={o.displayName} subtitle={`${o.name} · ${o.supportEmail}`} actions={
        <Button variant={o.status === 'ACTIVE' ? 'danger' : 'primary'} onClick={() => confirm('Change organization status?') && run(() => api(`/admin/organizations/${id}/status`, { body: { status: o.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' } }), 'Status updated.')}>
          {o.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
        </Button>
      } />
      {msg && <div className="mb-3"><Alert kind="success">{msg}</Alert></div>}
      <ErrorAlert error={err} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gross collections (all time)" value={formatNgn(m.collections.allTimeKobo)} />
        <Stat label="Refunds" value={formatNgn(m.refunds.totalKobo)} />
        <Stat label="Active paid" value={m.memberships.activePaid} />
        <Stat label="Open tasks" value={m.tasks.pendingGrant + m.tasks.pendingRemoval + m.tasks.pendingReview} />
      </div>
      <div className="space-y-4">
        <Card title="Paystack split-settlement setup (controlled process)">
          <Alert kind="info">Create the subaccount in the Paystack dashboard (or via the Subaccount API) after verifying the creator’s settlement bank details, then record its code here. Secret keys are never entered here.</Alert>
          {o.isDemo && <div className="mt-2"><Alert kind="warning">Demo organization — it can only use the demo payment provider.</Alert></div>}
          <form onSubmit={savePc} className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Subaccount code" required placeholder="ACCT_xxxxxxxx" value={pc.subaccountCode} onChange={(e) => setPc({ ...pc, subaccountCode: e.target.value })} />
            <Field label="Settlement bank (display)" value={pc.settlementBankName} onChange={(e) => setPc({ ...pc, settlementBankName: e.target.value })} />
            <Field label="Account number last 4 (display)" inputMode="numeric" maxLength={4} value={pc.accountNumberLast4} onChange={(e) => setPc({ ...pc, accountNumberLast4: e.target.value })} />
            <Field label="Platform fee (basis points)" type="number" min={0} max={3000} value={pc.platformFeeBps} onChange={(e) => setPc({ ...pc, platformFeeBps: Number(e.target.value) })} hint={`${pc.platformFeeBps / 100}% of plan price, sent to the main account as a flat transaction_charge.`} />
            <Select label="Paystack fee bearer" value={pc.feeBearer} onChange={(e) => setPc({ ...pc, feeBearer: e.target.value })}>
              <option value="SUBACCOUNT">Creator (subaccount)</option>
              <option value="ACCOUNT">Platform (main account)</option>
            </Select>
            <Select label="Status" value={pc.status} onChange={(e) => setPc({ ...pc, status: e.target.value })}>
              <option value="PENDING_REVIEW">Pending review (checkout blocked)</option>
              <option value="ACTIVE">Active (checkout allowed)</option>
              <option value="SUSPENDED">Suspended (checkout blocked)</option>
            </Select>
            <Field label="Internal notes" className="sm:col-span-2" value={pc.notes} onChange={(e) => setPc({ ...pc, notes: e.target.value })} />
            <div className="sm:col-span-2"><Button type="submit">Save payment setup</Button></div>
          </form>
        </Card>
        <Card title="Creator SaaS billing (recorded manually)">
          <p className="mb-2 text-sm text-gray-600">Kept separate from member payments. Nothing is deducted from members’ payments for this.</p>
          <ul className="mb-3 divide-y divide-gray-100 text-sm">
            {o.saasBilling.map((b: any) => <li key={b.id} className="flex justify-between py-2"><span>{formatDate(b.periodStart)} – {formatDate(b.periodEnd)} · {formatNgn(b.amountKobo)} {b.note && `· ${b.note}`}</span><Badge>{b.status}</Badge></li>)}
            {!o.saasBilling.length && <li className="py-2 text-gray-600">No records.</li>}
          </ul>
          <form onSubmit={addBill} className="grid gap-3 sm:grid-cols-5 sm:items-end">
            <Field label="From" type="date" required value={bill.periodStart} onChange={(e) => setBill({ ...bill, periodStart: e.target.value })} />
            <Field label="To" type="date" required value={bill.periodEnd} onChange={(e) => setBill({ ...bill, periodEnd: e.target.value })} />
            <Field label="Amount (₦)" inputMode="decimal" value={bill.amount} onChange={(e) => setBill({ ...bill, amount: e.target.value })} />
            <Select label="Status" value={bill.status} onChange={(e) => setBill({ ...bill, status: e.target.value })}><option>DUE</option><option>PAID</option><option>WAIVED</option></Select>
            <Button type="submit">Add</Button>
          </form>
        </Card>
        <Card title="Team and communities">
          <ul className="text-sm">{o.staff.map((s: any) => <li key={s.id}>{s.user.name} ({s.user.email}) — {s.role}</li>)}</ul>
          <ul className="mt-2 text-sm">{o.communities.map((c: any) => <li key={c.id}>/c/{c.slug} — {c.name} {c.isPublished ? '' : '(hidden)'}</li>)}</ul>
        </Card>
      </div>
    </>
  );
}
