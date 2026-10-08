export const metadata = { title: 'Privacy' };

export default function Privacy() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div role="note" className="mb-6 rounded-lg border-2 border-dashed border-red-400 bg-red-50 p-4 text-red-900">
        <strong>PLACEHOLDER — REQUIRES LEGAL REVIEW.</strong> This page is a draft outline only and must be reviewed by a qualified
        lawyer (including for compliance with the Nigeria Data Protection Act 2023) before CommunityPass is used with real members.
      </div>
      <h1 className="text-2xl font-bold">Privacy notice (draft)</h1>
      <div className="mt-4 space-y-4 text-gray-800">
        <p><strong>What we collect:</strong> your name, email address, WhatsApp phone number, the memberships you buy, payment references and status from Paystack, and your message preferences. We do not collect or store card details, NIN, or identity documents.</p>
        <p><strong>Why:</strong> to run your membership on behalf of the creator you joined, send receipts and membership notices, and let you manage your account.</p>
        <p><strong>WhatsApp messages:</strong> sent only if you opt in, from the CommunityPass business number on behalf of the named creator. Reply STOP to opt out at any time; this does not cancel your membership.</p>
        <p><strong>Who sees your data:</strong> the creator (and their staff) of the communities you join, Paystack (payments), Meta/WhatsApp (if you opt in), and our email provider. Each creator only sees members of their own communities.</p>
        <p><strong>Your choices:</strong> update preferences from your member page, or contact the creator’s support email listed on your membership.</p>
        <p className="text-sm text-gray-500">[Retention periods, lawful bases, data controller details, cross-border transfer information and DPO contact to be completed during legal review.]</p>
      </div>
    </main>
  );
}
