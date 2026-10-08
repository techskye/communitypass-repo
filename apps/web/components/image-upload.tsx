'use client';

import { useState } from 'react';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_UPLOAD_BYTES } from '@communitypass/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from './ui';

/** Community image upload. Client checks are for UX only — the server validates magic bytes and size. */
export function ImageUpload({ value, onChange }: { value: string | null; onChange: (url: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function pick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return setErr('Use a PNG, JPEG or WebP image.');
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) return setErr('Image must be 2 MB or smaller.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ url: string }>('/org/uploads', { form: fd });
      onChange(r.url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-gray-800">Community image (optional)</span>
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="Community" className="h-32 w-full rounded-lg object-cover sm:w-64" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
          {busy ? 'Uploading…' : value ? 'Replace image' : 'Upload image'}
          <input type="file" accept={ALLOWED_IMAGE_MIME_TYPES.join(',')} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
        </label>
        {value && <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>Remove</Button>}
      </div>
      <p className="text-sm text-gray-500">PNG, JPEG or WebP, up to 2 MB.</p>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
