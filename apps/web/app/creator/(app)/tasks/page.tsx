'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { formatDateTime, TASK_REASON_LABELS, TASK_TYPE_LABELS } from '@communitypass/shared';
import { api, ApiError, useApi } from '@/lib/api';
import { AccessBadge, Alert, Badge, Button, cx, Empty, EntitlementBadge, ErrorAlert, Loading, PageHeader, Pager } from '@/components/ui';

function TaskCard({ t, onDone }: { t: any; onDone: (msg?: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [mode, setMode] = useState<'none' | 'dismiss' | 'note'>('none');
  const [text, setText] = useState('');

  async function run(action: string, body: object = {}) {
    setBusy(action);
    setErr(null);
    try {
      const r = await api<any>(`/org/tasks/${t.id}/${action}`, { body });
      setMode('none');
      setText('');
      onDone(r?.outcome === 'cancelled_member_renewed' ? `${t.member.fullName} is paid up, so the removal was cancelled. Do not remove them.` : undefined);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  const typeColor = t.type === 'GRANT' ? 'green' : t.type === 'REMOVE' ? 'red' : 'amber';
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={typeColor}>{TASK_TYPE_LABELS[t.type]}</Badge>
            <span className="text-sm text-gray-600">{TASK_REASON_LABELS[t.reason] ?? t.reason}</span>
          </div>
          <p className="mt-2 text-lg font-semibold">{t.member.fullName}</p>
          <p className="font-mono text-base">
            <a href={`tel:${t.member.phoneE164}`} className="text-brand-700 underline">{t.member.phoneE164}</a>
          </p>
        </div>
        <EntitlementBadge value={t.entitlement} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-gray-500">Community</dt><dd>{t.community.name}</dd></div>
        <div><dt className="text-gray-500">Paid until</dt><dd>{formatDateTime(t.membership.paidUntil)}</dd></div>
        <div><dt className="text-gray-500">Group access</dt><dd><AccessBadge value={t.membership.accessStatus} /></dd></div>
        <div><dt className="text-gray-500">Created</dt><dd>{formatDateTime(t.createdAt)}</dd></div>
      </dl>
      {t.reasonDetail && <p className="mt-2 text-sm text-gray-700">{t.reasonDetail}</p>}
      {t.notes?.length > 0 && (
        <ul className="mt-2 space-y-1 border-l-2 border-gray-200 pl-3 text-sm text-gray-700">
          {t.notes.map((n: any) => <li key={n.id}>{n.body} <span className="text-gray-400">· {formatDateTime(n.createdAt)}</span></li>)}
        </ul>
      )}
      {t.dismissedReason && <p className="mt-2 text-sm text-gray-600">Dismissed: {t.dismissedReason}</p>}
      {t.cancelledReason && <p className="mt-2 text-sm text-gray-600">Cancelled: {t.cancelledReason}</p>}

      {t.status === 'OPEN' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {t.type === 'GRANT' && <Button size="sm" loading={busy === 'complete'} onClick={() => run('complete')}>I added them in WhatsApp</Button>}
          {t.type === 'REMOVE' && <Button size="sm" variant="danger" loading={busy === 'complete'} onClick={() => run('complete')}>I removed them in WhatsApp</Button>}
          {t.type === 'REVIEW' && <Button size="sm" onClick={() => setMode('note')}>Resolve with note</Button>}
          <Button size="sm" variant="secondary" onClick={() => setMode('dismiss')}>Dismiss</Button>
          {t.type !== 'REVIEW' && <Button size="sm" variant="ghost" onClick={() => setMode('note')}>Add note</Button>}
        </div>
      ) : (
        <div className="mt-4">
          <Button size="sm" variant="secondary" loading={busy === 'reopen'} onClick={() => run('reopen')}>Reopen</Button>
        </div>
      )}
      {mode !== 'none' && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'dismiss') void run('dismiss', { reason: text });
            else if (t.type === 'REVIEW') void run('complete', { note: text });
            else void run('notes', { note: text });
          }}
        >
          <label className="block text-sm font-medium" htmlFor={`txt-${t.id}`}>{mode === 'dismiss' ? 'Reason for dismissing' : 'Note'}</label>
          <textarea id={`txt-${t.id}`} required className="w-full rounded-lg border border-gray-300 p-2" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          {mode === 'dismiss' && t.type === 'REMOVE' && <p className="text-sm text-gray-600">Dismissing keeps this expired member in your group. You won&apos;t be asked again for this paid period.</p>}
          <div className="flex gap-2">
            <Button size="sm" type="submit" loading={!!busy}>Save</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setMode('none')}>Cancel</Button>
          </div>
        </form>
      )}
      {err && <div className="mt-3"><ErrorAlert error={err} /></div>}
    </li>
  );
}

function Tasks() {
  const sp = useSearchParams();
  const router = useRouter();
  const type = sp.get('type') ?? '';
  const status = sp.get('status') ?? 'OPEN';
  const [page, setPage] = useState(1);
  const [flash, setFlash] = useState<string | null>(null);
  const qs = new URLSearchParams({ status, page: String(page), ...(type ? { type } : {}) });
  const { data, error, loading, reload } = useApi<any>(`/org/tasks?${qs}`);
  const setFilter = (k: string, v: string) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v);
    else n.delete(k);
    setPage(1);
    router.replace(`/creator/tasks?${n}`);
  };

  return (
    <>
      <PageHeader
        title="Access tasks"
        subtitle="Your to-do list for the WhatsApp group. Statuses here are what you confirm — CommunityPass cannot see or change your group."
      />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter tasks">
        {[['', 'All'], ['GRANT', 'Add'], ['REMOVE', 'Remove'], ['REVIEW', 'Review']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter('type', v)} aria-pressed={type === v} className={cx('rounded-full px-3 py-1 text-sm', type === v ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white')}>{l}</button>
        ))}
        <span className="mx-1 text-gray-300">|</span>
        {[['OPEN', 'Open'], ['COMPLETED', 'Done'], ['DISMISSED', 'Dismissed'], ['CANCELLED', 'Cancelled']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter('status', v)} aria-pressed={status === v} className={cx('rounded-full px-3 py-1 text-sm', status === v ? 'bg-gray-800 text-white' : 'border border-gray-300 bg-white')}>{l}</button>
        ))}
      </div>
      {flash && <div className="mb-4"><Alert kind="info">{flash}</Alert></div>}
      {loading && <Loading />}
      <ErrorAlert error={error} onRetry={reload} />
      {data && !data.items.length && <Empty title={status === 'OPEN' ? 'All caught up 🎉' : 'No tasks'}>{status === 'OPEN' ? 'New paid members and expired members will show up here.' : null}</Empty>}
      <ul className="space-y-3">
        {data?.items.map((t: any) => (
          <TaskCard key={t.id} t={t} onDone={(m) => { setFlash(m ?? null); void reload(); }} />
        ))}
      </ul>
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}

export default function TasksPage() {
  return <Suspense fallback={<Loading />}><Tasks /></Suspense>;
}
