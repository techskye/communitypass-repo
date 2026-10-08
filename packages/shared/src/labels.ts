/** Human-friendly labels shared by the UI. Avoid implementation jargon in member-facing text. */

export const ENTITLEMENT_LABELS: Record<string, string> = {
  none: 'Not started',
  active: 'Active',
  grace: 'Grace period',
  expired: 'Expired',
};

/** Group access status is what the creator has confirmed — never live WhatsApp sync. */
export const ACCESS_STATUS_LABELS: Record<string, string> = {
  NOT_GRANTED: 'Not added yet',
  PENDING_GRANT: 'Waiting for creator to add',
  GRANTED: 'Added (creator confirmed)',
  PENDING_REMOVAL: 'Removal pending',
  REMOVED: 'Removed (creator confirmed)',
};

export const TASK_TYPE_LABELS: Record<string, string> = {
  GRANT: 'Grant access',
  REMOVE: 'Remove access',
  REVIEW: 'Review access',
};

export const TASK_REASON_LABELS: Record<string, string> = {
  NEW_PAID_MEMBER: 'New paid member',
  RENEWED_AFTER_REMOVAL: 'Renewed after being removed',
  MEMBERSHIP_EXPIRED: 'Membership expired (grace period over)',
  REFUND: 'Payment refunded',
  DISPUTE: 'Payment disputed',
  REOPENED: 'Reopened',
  MANUAL: 'Manual',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  SUCCESS: 'Successful',
  FAILED: 'Failed',
  REFUND_PENDING: 'Refund pending',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
  DISPUTED: 'Disputed',
  HELD_FOR_REVIEW: 'Held for review',
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Awaiting payment',
  PAID: 'Paid',
  FAILED: 'Failed',
  ABANDONED: 'Not completed',
  NEEDS_REVIEW: 'Needs review',
};

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  QUEUED: 'Queued',
  SENDING: 'Sending',
  ACCEPTED: 'Accepted by provider',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
  SUPPRESSED: 'Not sent (skipped)',
  NEEDS_REVIEW: 'Needs review',
};
