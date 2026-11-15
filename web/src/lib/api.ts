/** The one module that talks to the Acme Pay server. Same origin; the session is an httpOnly cookie. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export async function api<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (csrfToken !== null) headers['x-csrf-token'] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }),
  });
  const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error ?? 'http_error',
      data?.message ?? `Request failed (${response.status}).`,
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
