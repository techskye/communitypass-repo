import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-2xl font-bold">Community not found</h1>
      <p className="mt-2 text-gray-600">Check the link you were given, or ask the creator for a new one.</p>
      <Link href="/" className="mt-6 inline-block text-brand-700 underline">Go to CommunityPass</Link>
    </main>
  );
}
