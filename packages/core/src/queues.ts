/** Queue and job names shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  notifications: 'notifications',
  providerEvents: 'provider-events',
  maintenance: 'maintenance',
} as const;

export const JOBS = {
  deliverNotification: 'deliver-notification',
  processProviderEvent: 'process-provider-event',
  dispatchDue: 'dispatch-due-notifications',
  scheduleReminders: 'schedule-reminders',
  evaluateExpiries: 'evaluate-expiries',
  reconcilePayments: 'reconcile-pending-payments',
  creatorDigest: 'creator-daily-digest',
  sweepEvents: 'sweep-unprocessed-events',
  flagStuckSends: 'flag-stuck-sends',
  subscriptionBilling: 'subscription-billing',
} as const;
