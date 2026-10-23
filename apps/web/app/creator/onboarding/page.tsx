'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { DEFAULT_REMINDER_SETTINGS, PLAN_DURATIONS_DAYS, SUBSCRIPTION_TIERS, SubscriptionTier, formatNgn, slugify } from '@communitypass/shared';
import { api, ApiError, nairaInputToKobo } from '@/lib/api';
import { Alert, Button, Card, Checkbox, Field, Select, TextArea } from '@/components/ui';
import { ImageUpload } from '@/components/image-upload';

interface PlanDraft {
  name: string;
  price: string;
  durationDays: number;
}

export default function Onboarding() {
  const router = useRouter();
  const [org, setOrg] = useState({ organizationName: '', displayName: '', supportEmail: '' });
  const [community, setCommunity] = useState({
    name: '',
    description: '',
    slug: '',
    imageUrl: '' as string | null,
    whatsappInviteUrl: '',
    accessInstructions: 'Tap the invite link and request to join. I approve new members manually.',
    gracePeriodDays: 2,
    adminApprovalEnabled: false,
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [plans, setPlans] = useState<PlanDraft[]>([{ name: '30-day membership', price: '5000', durationDays: 30 }]);
  const [reminders, setReminders] = useState({ ...DEFAULT_REMINDER_SETTINGS, whatsappEnabled: true, emailEnabled: true });
  const [ack, setAck] = useState(false);
  const [tier, setTier] = useState<SubscriptionTier>('STARTER');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/org/onboarding', {
        body: {
          ...org,
          community: { ...community, imageUrl: community.imageUrl || null, isPublished: true },
          plans: plans.map((p) => ({ name: p.name, priceKobo: nairaInputToKobo(p.price), durationDays: p.durationDays })),
          reminders,
          tier,
          acknowledgeManualAccess: ack,
        },
      });
      router.replace('/creator');
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">Set up your community</h1>
      <p className="mt-1 text-gray-600">This takes about 5 minutes. You can change everything later.</p>
      <form onSubmit={submit} className="mt-6 space-y-5">
        <Card title="1. About you">
          <div className="space-y-4">
            <Field label="Business or organization name" required value={org.organizationName} onChange={(e) => setOrg({ ...org, organizationName: e.target.value })} />
            <Field label="Display name members will see" required value={org.displayName} onChange={(e) => setOrg({ ...org, displayName: e.target.value })} hint='e.g. "Coach Chioma"' />
            <Field label="Support email" type="email" required value={org.supportEmail} onChange={(e) => setOrg({ ...org, supportEmail: e.target.value })} hint="Shown to members who need help." />
          </div>
        </Card>

        <Card title="2. Your community">
          <div className="space-y-4">
            <Field
              label="Community name"
              required
              value={community.name}
              onChange={(e) => setCommunity({ ...community, name: e.target.value, slug: slugTouched ? community.slug : slugify(e.target.value) })}
            />
            <TextArea label="Description" value={community.description} onChange={(e) => setCommunity({ ...community, description: e.target.value })} />
            <Field
              label="Community link"
              required
              value={community.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setCommunity({ ...community, slug: e.target.value.toLowerCase() });
              }}
              hint={`Your signup page: ${typeof window !== 'undefined' ? window.location.origin : ''}/c/${community.slug || 'your-link'}`}
            />
            <ImageUpload value={community.imageUrl} onChange={(url) => setCommunity({ ...community, imageUrl: url })} />
          </div>
        </Card>

        <Card title="3. WhatsApp group">
          <div className="space-y-4">
            <Field
              label="Group invite link"
              required
              type="url"
              placeholder="https://chat.whatsapp.com/…"
              value={community.whatsappInviteUrl}
              onChange={(e) => setCommunity({ ...community, whatsappInviteUrl: e.target.value })}
              hint="Kept private: only paid, signed-in members can see it. It is never shown on your public page."
            />
            <TextArea label="Joining instructions for members" value={community.accessInstructions} onChange={(e) => setCommunity({ ...community, accessInstructions: e.target.value })} />
            <Alert kind="warning" title="Important: you manage the group yourself">
              <ul className="list-disc space-y-1 pl-5">
                <li>CommunityPass cannot add or remove people in WhatsApp. You approve join requests and remove expired members yourself, then mark them done in your task list.</li>
                <li>Invite links can be forwarded to anyone. Turn on <strong>“Approve new members”</strong> in your WhatsApp group settings so only people you approve can join.</li>
                <li>If a link leaks, reset it in WhatsApp (Group info → Invite via link → Reset link) and paste the new link here. CommunityPass cannot reset it for you.</li>
              </ul>
            </Alert>
            <Checkbox
              checked={community.adminApprovalEnabled}
              onChange={(e) => setCommunity({ ...community, adminApprovalEnabled: e.target.checked })}
              label="I have turned on “Approve new members” for this group"
            />
            <Select label="Grace period after expiry" value={community.gracePeriodDays} onChange={(e) => setCommunity({ ...community, gracePeriodDays: Number(e.target.value) })} hint="Extra days before you're asked to remove an expired member. Grace is not paid time.">
              {[0, 1, 2, 3, 5, 7].map((d) => (
                <option key={d} value={d}>{d === 0 ? 'No grace period' : `${d} day${d > 1 ? 's' : ''}`}</option>
              ))}
            </Select>
          </div>
        </Card>

        <Card title="4. Membership plans">
          <p className="mb-3 text-sm text-gray-600">Plans last an exact number of days (a 30-day plan is 30 days, not a calendar month). Payments are one-time; members renew manually.</p>
          <div className="space-y-4">
            {plans.map((p, i) => (
              <div key={i} className="grid gap-3 rounded-lg border border-gray-200 p-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
                <Field label="Plan name" required value={p.name} onChange={(e) => setPlans(plans.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Field label="Price (₦)" required inputMode="decimal" value={p.price} onChange={(e) => setPlans(plans.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                <Select label="Duration" value={p.durationDays} onChange={(e) => setPlans(plans.map((x, j) => (j === i ? { ...x, durationDays: Number(e.target.value) } : x)))}>
                  {PLAN_DURATIONS_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
                </Select>
                {plans.length > 1 && <Button type="button" variant="ghost" onClick={() => setPlans(plans.filter((_, j) => j !== i))}>Remove</Button>}
              </div>
            ))}
            {plans.length < 4 && (
              <Button type="button" variant="secondary" onClick={() => setPlans([...plans, { name: '', price: '', durationDays: 90 }])}>Add another plan</Button>
            )}
          </div>
        </Card>

        <Card title="5. Reminders">
          <div className="space-y-3">
            <Checkbox checked={reminders.beforeExpiryDays.includes(3)} onChange={(e) => setReminders({ ...reminders, beforeExpiryDays: e.target.checked ? [...new Set([3, ...reminders.beforeExpiryDays])] : reminders.beforeExpiryDays.filter((d) => d !== 3) })} label="3 days before expiry" />
            <Checkbox checked={reminders.beforeExpiryDays.includes(1)} onChange={(e) => setReminders({ ...reminders, beforeExpiryDays: e.target.checked ? [...new Set([...reminders.beforeExpiryDays, 1])] : reminders.beforeExpiryDays.filter((d) => d !== 1) })} label="1 day before expiry" />
            <Checkbox checked={reminders.onExpiry} onChange={(e) => setReminders({ ...reminders, onExpiry: e.target.checked })} label="On the day it expires" />
            <Checkbox checked={reminders.graceEnd} onChange={(e) => setReminders({ ...reminders, graceEnd: e.target.checked })} label="When the grace period ends" />
            <p className="text-sm text-gray-600">Reminders are sent between 8am and 8pm Lagos time. WhatsApp reminders only go to members who opted in.</p>
          </div>
        </Card>

        <Card title="6. Your CommunityPass plan">
          <p className="mb-3 text-sm text-gray-600">Start with a free 14-day trial — no card needed now. Member payments always go 100% to your bank account; this is your monthly CommunityPass subscription.</p>
          <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Plan">
            {Object.values(SUBSCRIPTION_TIERS).map((t) => (
              <label key={t.tier} className={`cursor-pointer rounded-lg border p-3 ${tier === t.tier ? 'border-brand-600 ring-2 ring-brand-100' : 'border-gray-200'}`}>
                <input type="radio" name="tier" className="sr-only" checked={tier === t.tier} onChange={() => setTier(t.tier)} />
                <span className="block font-semibold">{t.name}</span>
                <span className="block text-sm">{formatNgn(t.priceKobo)}/month</span>
                <span className="mt-1 block text-xs text-gray-600">
                  {t.maxCommunities ?? 'Unlimited'} {t.maxCommunities === 1 ? 'community' : 'communities'} · {t.maxActiveMembers ?? 'Unlimited'} members · {t.whatsappReminders ? 'WhatsApp reminders' : 'Email reminders'}
                </span>
              </label>
            ))}
          </div>
        </Card>

        <Card>
          <Checkbox
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            label="I understand that I must approve join requests and remove expired members in WhatsApp myself."
          />
        </Card>

        {err && (
          <Alert kind="error" title="Please check your details">
            {err.issues?.length ? (
              <ul className="list-disc pl-5">{err.issues.map((i) => <li key={i.path}>{i.path ? `${i.path}: ` : ''}{i.message}</li>)}</ul>
            ) : (
              err.message
            )}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={!ack} className="w-full">Create my community</Button>
        <p className="text-center text-sm text-gray-600">Live payments are switched on after a short payment setup review by the CommunityPass team.</p>
      </form>
    </main>
  );
}
