export async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, ms = 30_000): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const attempts = method === "GET" ? 2 : 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (err) {
      last = err;
    }
  }
  if (last instanceof Error && (last.name === "TimeoutError" || last.name === "AbortError")) {
    throw new Error(`request to ${new URL(String(url)).host} timed out after ${Math.round(ms / 1000)}s`);
  }
  throw last;
}
