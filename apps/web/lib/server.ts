import 'server-only';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Server-side fetch to the API for public, unauthenticated data. */
export async function serverApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`API ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}
