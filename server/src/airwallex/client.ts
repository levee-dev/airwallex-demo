import { AppError } from '../lib/errors';
import { SANDBOX_BUSINESS_FIELDS, sandboxAccountBody, type EndUserIdentity } from './sandbox-account';

/**
 * Acme's own Airwallex platform client. Acme is the platform: it owns its end users' onboarding,
 * so it creates each end user's connected account with its own keys and hands only the account id
 * to Levee. Levee never creates accounts; it issues the agent's card on that account.
 *
 * Endpoints:
 *  - POST /api/v1/authentication/login (x-client-id, x-api-key)
 *  - GET  /api/v1/accounts?page_num=0&page_size=10   the keys can use the Connected Account APIs
 *  - POST /api/v1/accounts/create, POST /api/v1/accounts/{id}/submit, POST /api/v1/accounts/{id}/update
 *  - GET  /api/v1/accounts/{id}
 *  - POST /api/v1/simulation/accounts/{id}/update_status   sandbox only: simulate onboarding to ACTIVE
 */

export interface AirwallexKeys {
  readonly clientId: string;
  readonly apiKey: string;
}

export interface AccountState {
  readonly id: string;
  readonly status: string;
}

export interface AirwallexClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Waits between activation attempts; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

class AirwallexCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail = '',
  ) {
    super(`Airwallex answered HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}

/** Activation right after submission can fail while Airwallex is still processing it. */
const ACTIVATION_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000];
const UNREACHABLE = 'Airwallex could not be reached. Try again.';

function accountState(value: unknown): AccountState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, status } = value as { id?: unknown; status?: unknown };
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, status: typeof status === 'string' ? status : 'UNKNOWN' };
}

export class AirwallexClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AirwallexClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The keys sign in and can use the Connected Account APIs. */
  async verify(keys: AirwallexKeys): Promise<void> {
    const token = await this.login(keys);
    try {
      await this.call(token, 'GET', '/api/v1/accounts?page_num=0&page_size=10');
    } catch (error) {
      if (error instanceof AirwallexCallError && [401, 403, 404, 405].includes(error.status)) {
        throw new AppError(
          422,
          'airwallex_accounts_unavailable',
          'These keys cannot create connected accounts. Use the keys of an Airwallex platform account with the Connected Account APIs enabled.',
        );
      }
      throw new AppError(502, 'airwallex_unreachable', UNREACHABLE);
    }
  }

  /** Creates the end user's own account. Returns as soon as Airwallex has an id for it. */
  async createAccount(keys: AirwallexKeys, identity: EndUserIdentity): Promise<AccountState> {
    const token = await this.login(keys);
    let created: AccountState | null;
    try {
      created = accountState(await this.call(token, 'POST', '/api/v1/accounts/create', sandboxAccountBody(identity)));
    } catch (error) {
      const detail = error instanceof AirwallexCallError && error.code ? ` (${error.code})` : '';
      throw new AppError(502, 'airwallex_account_failed', `Airwallex did not create the account${detail}. Try again.`);
    }
    if (created === null)
      throw new AppError(502, 'airwallex_account_failed', 'Airwallex did not return the new account.');
    return created;
  }

  /**
   * Submits the account (when still CREATED) and simulates onboarding to ACTIVE, retrying with
   * backoff. Resumes an account an earlier attempt left in SUBMITTED. Returns the last known state.
   */
  async activate(keys: AirwallexKeys, accountId: string): Promise<AccountState> {
    const token = await this.login(keys);
    const path = encodeURIComponent(accountId);
    let current = (await this.read(token, path)) ?? { id: accountId, status: 'CREATED' };
    if (current.status === 'ACTIVE') return current;
    if (current.status === 'CREATED') current = await this.submit(token, path, accountId);
    for (const delay of ACTIVATION_DELAYS_MS) {
      if (delay > 0) await this.sleep(delay);
      try {
        const body = { next_status: 'ACTIVE', force: true };
        const simulated = accountState(
          await this.call(token, 'POST', `/api/v1/simulation/accounts/${path}/update_status`, body),
        );
        if (simulated?.status === 'ACTIVE') return simulated;
      } catch {
        // Still processing; read the real state and try again.
      }
      current = (await this.read(token, path)) ?? current;
      if (current.status === 'ACTIVE') return current;
    }
    return current;
  }

  private async read(token: string, path: string): Promise<AccountState | null> {
    try {
      return accountState(await this.call(token, 'GET', `/api/v1/accounts/${path}`));
    } catch {
      return null;
    }
  }

  /**
   * Submits a CREATED account for KYC. If Airwallex asks for the business fields, they are filled in
   * and the account is submitted again; any other refusal surfaces Airwallex's own message.
   */
  private async submit(token: string, path: string, accountId: string): Promise<AccountState> {
    const attempt = async () =>
      accountState(await this.call(token, 'POST', `/api/v1/accounts/${path}/submit`, {})) ?? {
        id: accountId,
        status: 'SUBMITTED',
      };
    try {
      return await attempt();
    } catch (error) {
      const fixable = error instanceof AirwallexCallError && /industry_category_code|url/.test(error.detail);
      if (!fixable) {
        const read = await this.read(token, path);
        if (read !== null && read.status !== 'CREATED') return read;
        throw submitFailure(error);
      }
    }
    try {
      const update = { account_details: { business_details: SANDBOX_BUSINESS_FIELDS } };
      await this.call(token, 'POST', `/api/v1/accounts/${path}/update`, update);
      return await attempt();
    } catch (error) {
      throw submitFailure(error);
    }
  }

  private async login(keys: AirwallexKeys): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.baseUrl}/api/v1/authentication/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': keys.clientId, 'x-api-key': keys.apiKey },
        body: '{}',
      });
    } catch {
      throw new AppError(502, 'airwallex_unreachable', UNREACHABLE);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(401, 'airwallex_auth_failed', 'Airwallex rejected this client ID and API key.');
    }
    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    if (!response.ok || typeof body?.token !== 'string') {
      throw new AppError(502, 'airwallex_unreachable', 'Airwallex did not return an access token. Try again.');
    }
    return body.token;
  }

  private async call(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch {
      throw new AirwallexCallError(0, 'network');
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const { code, message } = (parsed ?? {}) as { code?: unknown; message?: unknown };
      throw new AirwallexCallError(
        response.status,
        typeof code === 'string' ? code : '',
        typeof message === 'string' ? message.slice(0, 300) : '',
      );
    }
    return parsed;
  }
}

function submitFailure(error: unknown): AppError {
  if (error instanceof AirwallexCallError && error.status !== 0) {
    const detail = error.detail || error.code || `HTTP ${error.status}`;
    return new AppError(502, 'airwallex_submit_failed', `Airwallex did not accept the account for KYC: ${detail}`);
  }
  return new AppError(502, 'airwallex_unreachable', UNREACHABLE);
}
