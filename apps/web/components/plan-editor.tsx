'use client';

import { FormEvent, useState } from 'react';
import { formatNgn, PLAN_DURATIONS_DAYS } from '@communitypass/shared';
import { api, ApiError, koboToNairaInput, nairaInputToKobo } from '@/lib/api';
import { Badge, Button, Card, ErrorAlert, Field, Select } from './ui';

export function PlanRow({ plan, canEdit, onSaved }: { plan: any; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [p, setP] = useState({ name: plan.name, price: koboToNairaInput(plan.priceKobo), durationDays: plan.durationDays, description: plan.description ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function save(body: object) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/org/plans/${plan.id}`, { method: 'PUT', body });
      setEdit(false);
      onSaved();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="rounded-lg border border-gray-200 p-3">
      {!edit ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-medium">{plan.name} {!plan.isActive && <Badge>Retired</Badge>}</p>
            <p className="text-sm text-gray-600">{formatNgn(plan.priceKobo)} · {plan.durationDays} days{plan.community ? ` · ${plan.community.name}` : ''}</p>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Edit</Button>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => save({ isActive: !plan.isActive })}>{plan.isActive ? 'Retire' : 'Reactivate'}</Button>
            </div>
          )}
        </div>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save({ name: p.name, priceKobo: nairaInputToKobo(p.price), durationDays: p.durationDays, description: p.description });
          }}
        >
          <Field label="Name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          <Field label="Price (₦)" inputMode="decimal" value={p.price} onChange={(e) => setP({ ...p, price: e.target.value })} />
          <Select label="Duration" value={p.durationDays} onChange={(e) => setP({ ...p, durationDays: Number(e.target.value) })}>
            {PLAN_DURATIONS_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
          </Select>
          <p className="text-sm text-gray-600 sm:col-span-3">Changes apply to new payments only. Existing payments and paid time are not affected.</p>
          <div className="flex gap-2 sm:col-span-3">
            <Button size="sm" type="submit" loading={busy}>Save</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEdit(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {err && <div className="mt-2"><ErrorAlert error={err} /></div>}
    </li>
  );
}

export function NewPlanForm({ communityId, onSaved }: { communityId: string; onSaved: () => void }) {
  const [p, setP] = useState({ name: '', price: '', durationDays: 30 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/org/communities/${communityId}/plans`, { body: { name: p.name, priceKobo: nairaInputToKobo(p.price), durationDays: p.durationDays } });
      setP({ name: '', price: '', durationDays: 30 });
      onSaved();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Add a plan">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
        <Field label="Plan name" required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        <Field label="Price (₦)" required inputMode="decimal" value={p.price} onChange={(e) => setP({ ...p, price: e.target.value })} />
        <Select label="Duration" value={p.durationDays} onChange={(e) => setP({ ...p, durationDays: Number(e.target.value) })}>
          {PLAN_DURATIONS_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
        </Select>
        <Button type="submit" loading={busy}>Add</Button>
      </form>
      {err && <div className="mt-2"><ErrorAlert error={err} /></div>}
    </Card>
  );
}
