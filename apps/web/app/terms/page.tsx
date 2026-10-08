export const metadata = { title: 'Membership terms' };

export default function Terms() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div role="note" className="mb-6 rounded-lg border-2 border-dashed border-red-400 bg-red-50 p-4 text-red-900">
        <strong>PLACEHOLDER — REQUIRES LEGAL REVIEW.</strong> Draft membership terms for discussion only. Not legal advice and not yet in force.
      </div>
      <h1 className="text-2xl font-bold">Membership terms (draft)</h1>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-gray-800">
        <li><strong>Paid time.</strong> A plan gives access for the exact number of days shown (7, 30, 90 or 365 days), counted from when your payment is confirmed. A 30-day plan is 30 days, not one calendar month.</li>
        <li><strong>Renewing early</strong> adds the new days to the end of your current paid time, so you never lose days.</li>
        <li><strong>One-time payments.</strong> There are no automatic charges. Your membership does not renew unless you pay again.</li>
        <li><strong>WhatsApp group access</strong> is managed manually by the creator. Being added can take time. The creator may remove members after their paid time (and any grace period) ends.</li>
        <li><strong>Invite links</strong> are for your personal use. The creator may change the link at any time.</li>
        <li><strong>Cancelling</strong> means you do not plan to renew. It does not end the time you already paid for. Refunds are at the creator’s discretion and are only shown once confirmed by the payment provider.</li>
        <li><strong>Support:</strong> contact the creator using the support email on the community page or your member page.</li>
      </ol>
      <p className="mt-6 text-sm text-gray-500">[Refund policy, dispute handling, governing law and creator/platform responsibilities to be completed during legal review.]</p>
    </main>
  );
}
