'use client';

import Link from 'next/link';
import { ReactNode, useId } from 'react';
import {
  ACCESS_STATUS_LABELS,
  ENTITLEMENT_LABELS,
  NOTIFICATION_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
} from '@communitypass/shared';
import type { ApiError } from '@/lib/api';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2.5 text-base',
        variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
        variant === 'secondary' && 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-brand-700 hover:bg-brand-50',
        className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'primary', className }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary'; className?: string }) {
  return (
    <Link
      href={href}
      className={cx(
        'inline-flex items-center justify-center rounded-lg px-4 py-2.5 font-medium transition',
        variant === 'primary' ? 'bg-brand-600 text-white hover:bg-brand-700' : 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50',
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'h-4 w-4' : 'h-6 w-6')}
    />
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-gray-500" aria-live="polite">
      <Spinner /> {label}
    </div>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-lg font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-gray-600">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Alert({ kind = 'info', children, title }: { kind?: 'info' | 'success' | 'warning' | 'error'; children: ReactNode; title?: string }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cx(
        'rounded-lg border p-3 text-sm',
        kind === 'info' && 'border-blue-200 bg-blue-50 text-blue-900',
        kind === 'success' && 'border-brand-200 bg-brand-50 text-brand-800',
        kind === 'warning' && 'border-amber-200 bg-amber-50 text-amber-900',
        kind === 'error' && 'border-red-200 bg-red-50 text-red-800',
      )}
    >
      {title && <p className="mb-1 font-semibold">{title}</p>}
      {children}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert kind="error">
      <span>{error.message}</span>
      {onRetry && (
        <button onClick={onRetry} className="ml-2 font-medium underline">
          Try again
        </button>
      )}
    </Alert>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
      <p className="font-medium text-gray-800">{title}</p>
      {children && <div className="mt-1 text-sm text-gray-600">{children}</div>}
    </div>
  );
}

const BADGE_COLORS: Record<string, string> = {
  green: 'bg-brand-100 text-brand-800',
  amber: 'bg-amber-100 text-amber-900',
  red: 'bg-red-100 text-red-800',
  gray: 'bg-gray-100 text-gray-700',
  blue: 'bg-blue-100 text-blue-800',
  purple: 'bg-purple-100 text-purple-800',
};

export function Badge({ color = 'gray', children }: { color?: keyof typeof BADGE_COLORS; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', BADGE_COLORS[color])}>{children}</span>;
}

export function EntitlementBadge({ value }: { value: string }) {
  const color = value === 'active' ? 'green' : value === 'grace' ? 'amber' : value === 'expired' ? 'red' : 'gray';
  return <Badge color={color}>{ENTITLEMENT_LABELS[value] ?? value}</Badge>;
}

export function AccessBadge({ value }: { value: string }) {
  const color = value === 'GRANTED' ? 'green' : value === 'PENDING_GRANT' || value === 'PENDING_REMOVAL' ? 'amber' : value === 'REMOVED' ? 'gray' : 'gray';
  return <Badge color={color}>{ACCESS_STATUS_LABELS[value] ?? value}</Badge>;
}

export function PaymentBadge({ value }: { value: string }) {
  const color = value === 'SUCCESS' ? 'green' : value === 'REFUNDED' || value === 'PARTIALLY_REFUNDED' ? 'purple' : value === 'DISPUTED' || value === 'HELD_FOR_REVIEW' ? 'red' : 'amber';
  return <Badge color={color}>{PAYMENT_STATUS_LABELS[value] ?? value}</Badge>;
}

export function OrderBadge({ value }: { value: string }) {
  const color = value === 'PAID' ? 'green' : value === 'PENDING' ? 'amber' : value === 'NEEDS_REVIEW' ? 'red' : 'gray';
  return <Badge color={color}>{ORDER_STATUS_LABELS[value] ?? value}</Badge>;
}

export function NotificationBadge({ value }: { value: string }) {
  const color = ['DELIVERED', 'READ', 'SENT', 'ACCEPTED'].includes(value)
    ? 'green'
    : value === 'FAILED' || value === 'NEEDS_REVIEW'
      ? 'red'
      : value === 'SUPPRESSED'
        ? 'gray'
        : 'blue';
  return <Badge color={color}>{NOTIFICATION_STATUS_LABELS[value] ?? value}</Badge>;
}

export function DemoBadge() {
  return <Badge color="purple">Demo</Badge>;
}

type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: string;
  children?: ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>;

export function Field({ label, hint, error, children, className, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className={cx('space-y-1', className)}>
      <label htmlFor={input.id ?? id} className="block text-sm font-medium text-gray-800">
        {label}
        {input.required && <span className="text-red-600" aria-hidden> *</span>}
      </label>
      {children ?? (
        <input
          id={input.id ?? id}
          aria-invalid={!!error || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:outline-none"
          {...input}
        />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-gray-500">
          {hint}
        </p>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

export function TextArea({ label, hint, ...rest }: { label: string; hint?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">
        {label}
      </label>
      <textarea id={id} className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:outline-none" rows={3} {...rest} />
      {hint && <p className="text-sm text-gray-500">{hint}</p>}
    </div>
  );
}

export function Select({ label, children, hint, ...rest }: { label: string; hint?: string; children: ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">
        {label}
      </label>
      <select id={id} className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:outline-none" {...rest}>
        {children}
      </select>
      {hint && <p className="text-sm text-gray-500">{hint}</p>}
    </div>
  );
}

export function Checkbox({ label, hint, ...rest }: { label: ReactNode; hint?: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex gap-3">
      <input id={id} type="checkbox" className="mt-1 h-5 w-5 shrink-0 rounded border-gray-300 accent-brand-600" {...rest} />
      <label htmlFor={id} className="text-sm text-gray-800">
        {label}
        {hint && <span className="mt-1 block text-gray-500">{hint}</span>}
      </label>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-600">{label}</p>
      <p className={cx('mt-1 text-2xl font-bold', tone === 'warn' && 'text-amber-700', tone === 'bad' && 'text-red-700')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/** Responsive list: table on wide screens, stacked cards on phones. */
export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  empty,
}: {
  rows: T[];
  columns: { header: string; cell: (r: T) => ReactNode; primary?: boolean }[];
  rowKey: (r: T) => string;
  empty?: ReactNode;
}) {
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((c) => (
                <th key={c.header} scope="col" className="px-3 py-2 text-left font-semibold text-gray-700">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="align-top">
                {columns.map((c) => (
                  <td key={c.header} className="px-3 py-2">
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="rounded-xl border border-gray-200 bg-white p-4">
            <dl className="space-y-1.5 text-sm">
              {columns.map((c) => (
                <div key={c.header} className={c.primary ? 'text-base font-semibold' : 'flex justify-between gap-3'}>
                  {!c.primary && <dt className="text-gray-500">{c.header}</dt>}
                  <dd className={c.primary ? '' : 'text-right'}>{c.cell(r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span>
        Page {page} of {pages}
      </span>
      <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
