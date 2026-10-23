import { formatDateTime, formatNgn } from '@communitypass/shared';

/**
 * Message content. WhatsApp messages are sent ONLY as pre-approved templates; the body
 * parameters below must match the approved template variables ({{1}}, {{2}}, ...).
 * See INTEGRATION_NOTES.md for the template texts to submit to Meta.
 */
export interface MessageContext {
  memberName: string;
  creatorName: string;
  communityName: string;
  amountKobo?: number;
  paidUntil?: Date | null;
  graceEndsAt?: Date | null;
  portalUrl: string;
  supportEmail: string;
  timezone: string;
}

export type TemplatePurposeKey =
  | 'PAYMENT_CONFIRMATION'
  | 'ACCESS_INSTRUCTIONS'
  | 'RENEWAL_REMINDER'
  | 'EXPIRY_NOTICE';

export interface BuiltMessage {
  templatePurpose: TemplatePurposeKey;
  whatsappParams: string[];
  whatsappPreview: string;
  email: { subject: string; text: string; html: string };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function html(title: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:auto;padding:16px">
<h2 style="color:#15803d">${esc(title)}</h2>
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
${cta ? `<p><a href="${esc(cta.url)}" style="background:#16a34a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(cta.label)}</a></p>` : ''}
<p style="color:#666;font-size:12px">Sent by CommunityPass on behalf of the creator named above. CommunityPass manages memberships; it does not control WhatsApp groups.</p>
</body></html>`;
}

export function buildMemberMessage(
  type: 'PAYMENT_RECEIPT' | 'ACCESS_INSTRUCTIONS' | 'RENEWAL_REMINDER' | 'EXPIRY_NOTICE' | 'GRACE_ENDED',
  c: MessageContext,
): BuiltMessage {
  const until = formatDateTime(c.paidUntil ?? null, c.timezone);
  const amount = c.amountKobo !== undefined ? formatNgn(c.amountKobo) : '';
  const sig = `Questions? Contact ${c.creatorName} at ${c.supportEmail}.`;
  switch (type) {
    case 'PAYMENT_RECEIPT': {
      const lines = [
        `Hi ${c.memberName}, we received your payment of ${amount} for ${c.communityName} by ${c.creatorName}.`,
        `Your membership is paid until ${until} (Lagos time).`,
        sig,
      ];
      return {
        templatePurpose: 'PAYMENT_CONFIRMATION',
        whatsappParams: [c.memberName, amount, c.communityName, c.creatorName, until],
        whatsappPreview: lines.join(' '),
        email: {
          subject: `Payment received — ${c.communityName}`,
          text: lines.join('\n\n') + `\n\nYour memberships: ${c.portalUrl}`,
          html: html('Payment received', lines, { label: 'View my membership', url: c.portalUrl }),
        },
      };
    }
    case 'ACCESS_INSTRUCTIONS': {
      const lines = [
        `Hi ${c.memberName}, welcome to ${c.communityName}!`,
        `Sign in to your CommunityPass member page to see how to join the WhatsApp group. ${c.creatorName} approves join requests and adds members manually, so it may take a little while.`,
        sig,
      ];
      return {
        templatePurpose: 'ACCESS_INSTRUCTIONS',
        whatsappParams: [c.memberName, c.communityName, c.creatorName, c.portalUrl],
        whatsappPreview: lines.join(' '),
        email: {
          subject: `How to join ${c.communityName}`,
          text: lines.join('\n\n') + `\n\nSign in: ${c.portalUrl}`,
          html: html(`Welcome to ${c.communityName}`, lines, { label: 'See access instructions', url: c.portalUrl }),
        },
      };
    }
    case 'RENEWAL_REMINDER': {
      const lines = [
        `Hi ${c.memberName}, your ${c.communityName} membership ends on ${until} (Lagos time).`,
        `To keep your access, renew from your member page. Renewing early keeps your remaining days.`,
        sig,
      ];
      return {
        templatePurpose: 'RENEWAL_REMINDER',
        whatsappParams: [c.memberName, c.communityName, until, c.portalUrl],
        whatsappPreview: lines.join(' '),
        email: {
          subject: `Your ${c.communityName} membership ends ${until}`,
          text: lines.join('\n\n') + `\n\nRenew: ${c.portalUrl}`,
          html: html('Membership renewal reminder', lines, { label: 'Renew membership', url: c.portalUrl }),
        },
      };
    }
    case 'EXPIRY_NOTICE':
    case 'GRACE_ENDED': {
      const grace = type === 'EXPIRY_NOTICE' && c.graceEndsAt
        ? ` You have a grace period until ${formatDateTime(c.graceEndsAt, c.timezone)} before ${c.creatorName} removes expired members from the group.`
        : ` ${c.creatorName} may now remove you from the WhatsApp group.`;
      const lines = [
        `Hi ${c.memberName}, your ${c.communityName} membership expired on ${until} (Lagos time).${grace}`,
        `You can renew any time from your member page.`,
        sig,
      ];
      return {
        templatePurpose: 'EXPIRY_NOTICE',
        whatsappParams: [c.memberName, c.communityName, until, c.portalUrl],
        whatsappPreview: lines.join(' '),
        email: {
          subject: `Your ${c.communityName} membership has expired`,
          text: lines.join('\n\n') + `\n\nRenew: ${c.portalUrl}`,
          html: html('Membership expired', lines, { label: 'Renew membership', url: c.portalUrl }),
        },
      };
    }
  }
}

export function buildMagicLinkEmail(link: string): { subject: string; text: string; html: string } {
  const lines = [
    'Use the button below to sign in to your CommunityPass member page.',
    'This link expires in 15 minutes and can be used once. If you did not request it, you can ignore this email.',
  ];
  return {
    subject: 'Your CommunityPass sign-in link',
    text: `${lines.join('\n\n')}\n\n${link}`,
    html: html('Sign in to CommunityPass', lines, { label: 'Sign in', url: link }),
  };
}

export function buildStaffInviteEmail(orgName: string, link: string) {
  const lines = [`You have been invited to help manage ${orgName} on CommunityPass.`, 'This invite expires in 7 days.'];
  return {
    subject: `Invitation to ${orgName} on CommunityPass`,
    text: `${lines.join('\n\n')}\n\n${link}`,
    html: html('You are invited', lines, { label: 'Accept invite', url: link }),
  };
}

export function buildDigestEmail(p: {
  orgName: string;
  pendingGrants: number;
  pendingRemovals: number;
  pendingReviews: number;
  expiringSoon: number;
  failedNotifications: number;
  url: string;
}) {
  const lines = [
    `Here is today's CommunityPass summary for ${p.orgName}.`,
    `Members waiting to be added to WhatsApp: ${p.pendingGrants}`,
    `Expired members to remove from WhatsApp: ${p.pendingRemovals}`,
    `Payments needing review: ${p.pendingReviews}`,
    `Memberships ending in the next 3 days: ${p.expiringSoon}`,
    `Messages that failed to send: ${p.failedNotifications}`,
    'Remember: CommunityPass cannot add or remove people in WhatsApp for you. Please action these in the group, then mark them done.',
  ];
  return {
    subject: `Today's access tasks — ${p.orgName}`,
    text: `${lines.join('\n')}\n\n${p.url}`,
    html: html('Daily access tasks', lines, { label: 'Open task queue', url: p.url }),
  };
}

export function buildBillingEmail(
  key: string,
  p: { orgName: string; tier: string; trialEndsAt: Date; currentPeriodEnd: Date | null; cardLast4: string | null; url: string },
) {
  const plan = `${p.tier.charAt(0)}${p.tier.slice(1).toLowerCase()}`;
  const when = (d: Date | null) => formatDateTime(d);
  const texts: Record<string, { subject: string; title: string; lines: string[]; cta: string }> = {
    trial_ending: {
      subject: `Your CommunityPass trial ends ${when(p.trialEndsAt)}`,
      title: 'Your free trial is ending soon',
      lines: [
        `Your ${plan} plan trial for ${p.orgName} ends on ${when(p.trialEndsAt)} (Lagos time).`,
        'Add a card to keep taking member payments without interruption. Your card is charged monthly and you can cancel any time.',
      ],
      cta: 'Choose plan & add card',
    },
    payment_due: {
      subject: 'Action needed: your CommunityPass subscription',
      title: 'Your subscription payment is due',
      lines: [
        `Your trial or paid period for ${p.orgName} has ended. You have a 7-day grace period before new member payments are paused.`,
        'Existing members keep the time they already paid for.',
      ],
      cta: 'Pay now',
    },
    payment_failed: {
      subject: 'We could not charge your card',
      title: 'Subscription payment failed',
      lines: [
        `We could not charge your card${p.cardLast4 ? ` ending ${p.cardLast4}` : ''} for your ${plan} plan. We will retry automatically.`,
        'To avoid pausing new member payments, pay now or use a different card.',
      ],
      cta: 'Update payment',
    },
    paused: {
      subject: 'New member payments are paused',
      title: 'Your subscription is unpaid',
      lines: [
        `Your community pages for ${p.orgName} are no longer taking member payments because the subscription is unpaid.`,
        'Existing members keep the time they paid for. Pay now to resume immediately.',
      ],
      cta: 'Resume subscription',
    },
    cancelled: {
      subject: 'Your CommunityPass subscription has ended',
      title: 'Subscription ended',
      lines: [`Your subscription for ${p.orgName} has ended and new member payments are paused. You can subscribe again any time.`],
      cta: 'Subscribe again',
    },
    payment_receipt: {
      subject: `Receipt: CommunityPass ${plan} plan`,
      title: 'Thanks — payment received',
      lines: [`Your ${plan} plan for ${p.orgName} is paid until ${when(p.currentPeriodEnd)} (Lagos time).`],
      cta: 'View billing',
    },
  };
  const t = texts[key] ?? texts.payment_due;
  return {
    subject: t.subject,
    text: `${t.lines.join('\n\n')}\n\n${p.url}`,
    html: html(t.title, t.lines, { label: t.cta, url: p.url }),
  };
}
