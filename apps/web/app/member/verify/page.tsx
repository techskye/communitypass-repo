'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, LinkButton, Loading } from '@/components/ui';

/** The token is in the URL fragment, so it is never sent to (or logged by) any server. */
export default function Verify() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    history.replaceState(null, '', window.location.pathname); // drop the token from the address bar
    if (!token) {
      setErr('This sign-in link is incomplete.');
      return;
    }
    api('/member/auth/verify', { body: { token } })
      .then(() => router.replace('/member'))
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not sign you in.'));
  }, [router]);
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      {err ? (
        <div className="space-y-4">
          <Alert kind="error">{err}</Alert>
          <LinkButton href="/member/login">Request a new link</LinkButton>
        </div>
      ) : (
        <Loading label="Signing you in…" />
      )}
    </main>
  );
}
