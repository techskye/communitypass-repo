'use client';

import { FormEvent, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Checkbox, ErrorAlert, Field, Select, TextArea } from './ui';
import { ImageUpload } from './image-upload';

export interface CommunityDraft {
  name: string;
  description: string;
  slug: string;
  imageUrl: string | null;
  whatsappInviteUrl: string;
  accessInstructions: string;
  gracePeriodDays: number;
  adminApprovalEnabled: boolean;
  isPublished: boolean;
}

export function CommunityForm({ initial, path, method, onSaved, readOnly }: { initial: CommunityDraft; path: string; method: 'POST' | 'PUT'; onSaved: (c: any) => void; readOnly?: boolean }) {
  const [c, setC] = useState<CommunityDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const inviteChanged = method === 'PUT' && c.whatsappInviteUrl !== initial.whatsappInviteUrl;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const r = await api(path, { method, body: c });
      setSaved(true);
      onSaved(r);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Card title="Community details">
        <fieldset disabled={readOnly} className="space-y-4">
          <Field label="Name" required value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          <TextArea label="Description (public)" value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} />
          <Field label="Community link" required value={c.slug} onChange={(e) => setC({ ...c, slug: e.target.value.toLowerCase() })} hint={`/c/${c.slug}`} />
          {!readOnly && <ImageUpload value={c.imageUrl} onChange={(url) => setC({ ...c, imageUrl: url })} />}
          <Field
            label="WhatsApp group invite link (private)"
            required
            type="url"
            value={c.whatsappInviteUrl}
            onChange={(e) => setC({ ...c, whatsappInviteUrl: e.target.value })}
            hint="Only shown to paid, signed-in members. Never on your public page."
          />
          {inviteChanged && (
            <Alert kind="info">
              Saving updates the link members see in CommunityPass. It does not reset the old link inside WhatsApp — do that in WhatsApp (Group info → Invite via link → Reset link) if the old link leaked.
            </Alert>
          )}
          <TextArea label="Joining instructions (shown to paid members)" value={c.accessInstructions} onChange={(e) => setC({ ...c, accessInstructions: e.target.value })} />
          <Select label="Grace period after expiry" value={c.gracePeriodDays} onChange={(e) => setC({ ...c, gracePeriodDays: Number(e.target.value) })} hint="Changing this affects current members' grace periods.">
            {[0, 1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d === 0 ? 'No grace period' : `${d} days`}</option>)}
          </Select>
          <Checkbox checked={c.adminApprovalEnabled} onChange={(e) => setC({ ...c, adminApprovalEnabled: e.target.checked })} label="“Approve new members” is turned on in WhatsApp for this group" />
          <Checkbox checked={c.isPublished} onChange={(e) => setC({ ...c, isPublished: e.target.checked })} label="Public signup page is live" />
          {saved && <Alert kind="success">Saved.</Alert>}
          <ErrorAlert error={err} />
          {!readOnly && <Button type="submit" loading={busy}>Save</Button>}
        </fieldset>
        {readOnly && <p className="mt-3 text-sm text-gray-600">Only the owner can edit communities.</p>}
      </Card>
    </form>
  );
}
