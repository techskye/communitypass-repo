import Link from 'next/link';

export default function Landing() {
  return (
    <main className="mx-auto max-w-5xl px-4">
      <header className="flex items-center justify-between py-5">
        <span className="text-xl font-bold text-brand-700">CommunityPass</span>
        <nav className="flex gap-3 text-sm">
          <Link href="/member/login" className="rounded-lg px-3 py-2 hover:bg-gray-100">
            Member sign-in
          </Link>
          <Link href="/creator/login" className="rounded-lg bg-brand-600 px-3 py-2 font-medium text-white hover:bg-brand-700">
            Creator sign-in
          </Link>
        </nav>
      </header>

      <section className="py-10 sm:py-16">
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl">Run your paid WhatsApp community without the spreadsheet.</h1>
        <p className="mt-4 max-w-2xl text-lg text-gray-700">
          CommunityPass gives Nigerian creators a signup page, Naira payments through Paystack, renewal reminders, and a simple to-do list of who to add or remove from your WhatsApp group.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/creator/signup" className="rounded-lg bg-brand-600 px-5 py-3 font-medium text-white hover:bg-brand-700">
            Create your community
          </Link>
          <Link href="/member/login" className="rounded-lg border border-gray-300 bg-white px-5 py-3 font-medium hover:bg-gray-50">
            I&apos;m a member
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ['Signup & payment', 'Share one link. Members pick a 7, 30, 90 or 365-day plan and pay in Naira on Paystack’s secure checkout.'],
          ['Renewal reminders', 'Members get reminders before their paid time ends — on WhatsApp only if they opted in, plus email.'],
          ['Access to-do list', 'See exactly who to approve into your group and who has expired. You stay in control inside WhatsApp.'],
        ].map(([t, d]) => (
          <div key={t} className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold">{t}</h2>
            <p className="mt-2 text-gray-600">{d}</p>
          </div>
        ))}
      </section>

      <section className="mt-10 rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
        <h2 className="font-semibold">How group access works</h2>
        <p className="mt-2">
          CommunityPass does not add or remove people in WhatsApp for you. You approve join requests and remove expired members yourself, then tick them off in your task list. Invite links can be forwarded, so we recommend turning on “Approve new members” in your WhatsApp group settings.
        </p>
      </section>
    </main>
  );
}
