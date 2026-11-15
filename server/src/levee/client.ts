/** A failed Levee call, reduced to its status, error code and message. */
export class LeveeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LeveeError';
  }
}

/** Acme's own deadline expired before Levee answered. Distinct from `levee_unreachable`. */
export const LEVEE_TIMEOUT = 'levee_timeout';

export interface LeveeClientOptions {
  readonly baseUrl: string;
  readonly platformKey: string;
  readonly tenantId: string;
  /** Levee's console origin; every unsafe call carries it with a CSRF token. */
  readonly consoleOrigin: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

type Method = 'GET' | 'POST' | 'PATCH';

/** A card swipe waits on the issuer's round trip, so it gets a longer budget than other calls. */
const SWIPE_TIMEOUT_MS = 40_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SWIPE_ROUTE = /^\/v1\/agents\/[^/]+\/purchase$/;
const CSRF_REFRESH_SKEW_MS = 30_000;

interface Reply {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Levee's public API, called with the platform key on behalf of one consumer tenant. Person-scoped
 * calls carry `x-levee-end-user`, always taken from Acme's own session, never from a browser header.
 * Unsafe calls carry a short-lived CSRF token and the console Origin, as Levee requires.
 */
export class LeveeClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private csrf: { readonly token: string; readonly expiresAtMs: number } | null = null;

  constructor(private readonly options: LeveeClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get tenantId(): string {
    return this.options.tenantId;
  }

  get<T>(path: string, endUser?: string): Promise<T> {
    return this.call<T>('GET', path, undefined, endUser);
  }

  post<T>(path: string, body: unknown = {}, endUser?: string): Promise<T> {
    return this.call<T>('POST', path, body, endUser);
  }

  patch<T>(path: string, body: unknown = {}, endUser?: string): Promise<T> {
    return this.call<T>('PATCH', path, body, endUser);
  }

  private async call<T>(method: Method, path: string, body: unknown, endUser: string | undefined): Promise<T> {
    const unsafe = method !== 'GET';
    let reply = await this.send(method, path, body, endUser, unsafe ? await this.csrfToken() : null);
    if (unsafe && reply.status === 403) {
      // The token is short-lived and may have been revoked. A refused request never reached a
      // handler, so retrying once with a fresh token cannot repeat a side effect.
      this.csrf = null;
      reply = await this.send(method, path, body, endUser, await this.csrfToken());
    }
    let parsed: unknown;
    try {
      parsed = reply.text ? JSON.parse(reply.text) : null;
    } catch {
      throw new LeveeError(502, 'levee_bad_response', 'Levee returned a non-JSON response');
    }
    if (!reply.ok) {
      const error = (parsed ?? {}) as { error?: unknown; message?: unknown };
      throw new LeveeError(
        reply.status,
        typeof error.error === 'string' ? error.error : 'levee_error',
        typeof error.message === 'string' ? error.message : `Levee answered HTTP ${reply.status}`,
      );
    }
    return parsed as T;
  }

  private async send(
    method: Method,
    path: string,
    body: unknown,
    endUser: string | undefined,
    csrfToken: string | null,
  ): Promise<Reply> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.platformKey}`,
      'x-levee-tenant': this.options.tenantId,
    };
    if (endUser !== undefined) headers['x-levee-end-user'] = endUser;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken !== null) {
      headers['x-levee-csrf'] = csrfToken;
      headers.origin = this.options.consoleOrigin;
    }
    const timeoutMs = method === 'POST' && SWIPE_ROUTE.test(path) ? SWIPE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: deadline,
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } catch {
      if (deadline.aborted) {
        throw new LeveeError(504, LEVEE_TIMEOUT, `Levee did not answer within ${timeoutMs / 1000} seconds`);
      }
      throw new LeveeError(502, 'levee_unreachable', 'Levee could not be reached');
    }
  }

  /** `GET /v1/csrf-token`, cached until shortly before it expires. */
  private async csrfToken(): Promise<string> {
    if (this.csrf !== null && this.csrf.expiresAtMs - CSRF_REFRESH_SKEW_MS > this.now()) return this.csrf.token;
    const reply = await this.send('GET', '/v1/csrf-token', undefined, undefined, null);
    if (!reply.ok)
      throw new LeveeError(reply.status, 'csrf_unavailable', `Levee refused a CSRF token (HTTP ${reply.status})`);
    let token: unknown;
    let expiresAt: unknown;
    try {
      ({ token, expires_at: expiresAt } = JSON.parse(reply.text) as { token?: unknown; expires_at?: unknown });
    } catch {
      throw new LeveeError(502, 'levee_bad_response', 'Levee returned an unusable CSRF token');
    }
    const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (typeof token !== 'string' || token.length === 0 || !Number.isFinite(expiresAtMs)) {
      throw new LeveeError(502, 'levee_bad_response', 'Levee returned an unusable CSRF token');
    }
    this.csrf = { token, expiresAtMs };
    return token;
  }
}
