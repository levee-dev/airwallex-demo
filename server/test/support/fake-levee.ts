import type { LeveeDeclarationResult, LeveePurchaseResult } from '../../src/levee/types';
import { defined } from './defined';

/**
 * An in-memory stand-in for the Levee API routes Acme calls, enough to drive whole flows in tests.
 * It is not Levee: it applies no policy beyond what a test scripts with `nextDeclaration` and
 * `nextPurchase`. Every id it hands out is obviously fake.
 */

export const TEST_PLATFORM_ID = 'plt_test_123';
export const TEST_TENANT_ID = 'ten_test_123';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

interface FakeMandate {
  id: string;
  version: number;
  state: string;
  body: Record<string, unknown>;
  cardId: string | null;
  spentMinor: number;
  freezeStatus: string | null;
}

interface FakeChallenge {
  id: string;
  mandateId: string;
  mandateVersion: number;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export class FakeLevee {
  readonly calls: Call[] = [];
  readonly mandates = new Map<string, FakeMandate>();
  readonly challenges = new Map<string, FakeChallenge>();
  tenant = {
    id: TEST_TENANT_ID,
    environment: 'test',
    program_type: 'consumer',
    display_name: 'Acme Pay sandbox',
    webauthn: { rpId: 'localhost', origins: [] as string[] },
  };
  nextDeclaration: LeveeDeclarationResult | null = null;
  nextPurchase: LeveePurchaseResult | Error | null = null;
  decisions: unknown[] = [];
  /** How many issuer-account assignments Levee refuses (account not ACTIVE yet in its view). */
  issuerAccountRefusals = 0;
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_test_${this.counter}`;
  }

  callsTo(method: string, pattern: RegExp): Call[] {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  readonly fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(input, init));

  private respond(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Response {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = `${url.pathname}${url.search}`;
    this.calls.push({ method, path, body, headers });
    if (method !== 'GET' && (headers['x-levee-csrf'] !== 'csrf_test' || headers.origin === undefined)) {
      return json({ error: 'csrf_required' }, 403);
    }
    return this.route(method, url.pathname, url.searchParams, (body ?? {}) as Record<string, unknown>);
  }

  private mandate(reference: string): FakeMandate {
    const mandate = this.mandates.get(decodeURIComponent(reference).split('@')[0] ?? '');
    if (mandate === undefined) throw new Error(`unknown mandate ${reference}`);
    return mandate;
  }

  view(mandate: FakeMandate) {
    const constraints = mandate.body.constraints as { budget: { currency: string; max: number } };
    return {
      id: mandate.id,
      version: mandate.version,
      state: mandate.state,
      card_id: mandate.cardId,
      card_last4: mandate.cardId === null ? null : '4242',
      remaining_minor: constraints.budget.max - mandate.spentMinor,
      spent_minor: mandate.spentMinor,
      freeze_status: mandate.freezeStatus,
      constraints: { budget: constraints.budget, amount_per_txn: constraints.budget },
    };
  }

  private created(mandate: FakeMandate) {
    const constraints = mandate.body.constraints as { budget: { max: number }; window: { not_after: string } };
    return {
      id: mandate.id,
      version: mandate.version,
      state: 'pending_approval',
      approval_expires_at: new Date(this.now().getTime() + 15 * 60_000).toISOString(),
      approval_card: {
        title: String(mandate.body.purpose),
        summary: 'Spending terms',
        agent: { id: String(mandate.body.agent_id), name: 'Agent' },
        rows: [
          {
            field: 'constraints.budget.max',
            label: 'Total',
            value: `$${constraints.budget.max / 100}`,
            source: 'user',
          },
          { field: 'constraints.window', label: 'Until', value: constraints.window.not_after, source: 'user' },
          { field: 'constraints.mcc', label: 'Category', value: 'Electronics', source: 'user' },
        ],
        warnings: [],
      },
      adjustments: [],
      warnings: [],
      mandate: mandate.body,
    };
  }

  /** Adds a pending challenge, as Levee does when a swipe needs the person. */
  openChallenge(mandateId: string, amountMinor: number): FakeChallenge {
    const mandate = this.mandate(mandateId);
    const challenge: FakeChallenge = {
      id: this.id('chl'),
      mandateId,
      mandateVersion: mandate.version,
      amountMinor,
      currency: 'USD',
      status: 'PENDING',
      createdAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(),
    };
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  private route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response {
    const parts = path.split('/').filter(Boolean);
    // Every id this fake hands out contains an underscore; no Levee path word does.
    const key = `${method} /${parts.map((part) => (part.includes('_') ? ':id' : part)).join('/')}`;
    const id = decodeURIComponent(parts.find((part) => part.includes('_')) ?? '');
    switch (key) {
      case 'GET /v1/csrf-token':
        return json({ token: 'csrf_test', expires_at: new Date(this.now().getTime() + 3_600_000).toISOString() });
      case 'GET /v1/platforms/me':
        return json({ id: TEST_PLATFORM_ID });
      case 'GET /v1/platforms/:id/tenants':
        return json(id === TEST_PLATFORM_ID ? [this.tenant] : []);
      case 'PATCH /v1/platforms/:id/tenants/:id/webauthn':
        this.tenant.webauthn = { rpId: body.rp_id as string, origins: body.origins as string[] };
        return json({ rp_id: body.rp_id, origins: body.origins });
      case 'GET /v1/config':
        return json({ mode: 'simulator', issuer: 'airwallex', live_issuer: false });
      case 'POST /v1/approvers':
        return json({ id: this.id('apv') }, 201);
      case 'POST /v1/approvers/:id/issuer-account':
        if (this.issuerAccountRefusals > 0) {
          this.issuerAccountRefusals -= 1;
          return json({ error: 'issuer_account_inactive', message: 'the connected account is SUBMITTED' }, 422);
        }
        return json({ id, issuer_account_ref: body.issuer_account_ref });
      case 'POST /v1/approvers/:id/passkeys/options':
        return json({ request_id: this.id('wrq'), options: { challenge: 'test-challenge' } });
      case 'POST /v1/approvers/:id/passkeys':
        return json({ ok: true }, 201);
      case 'POST /v1/agents':
        return json({ id: this.id('agent') }, 201);
      case 'POST /v1/mandates': {
        const mandate: FakeMandate = {
          id: this.id('mdt'),
          version: 1,
          state: 'pending_approval',
          body,
          cardId: null,
          spentMinor: 0,
          freezeStatus: null,
        };
        this.mandates.set(mandate.id, mandate);
        return json(this.created(mandate), 201);
      }
      case 'GET /v1/mandates/:id':
        return json(this.view(this.mandate(id)));
      case 'GET /v1/mandates/:id/evidence.json':
        return json({ mandate: this.mandate(id).id, entries: [] });
      case 'POST /v1/mandates/:id/approve/options':
      case 'POST /v1/challenges/:id/approve/options':
        return json({
          request_id: this.id('wrq'),
          webauthn_request: { challenge: 'test-challenge' },
          options: { challenge: 'test-challenge' },
        });
      case 'POST /v1/mandates/:id/resume/options':
        return json({ request_id: this.id('wrq'), options: { challenge: 'test-challenge' } });
      case 'POST /v1/mandates/:id/approve': {
        const mandate = this.mandate(id);
        mandate.state = 'active';
        mandate.cardId = 'crd_test_1';
        return json({ state: 'active' });
      }
      case 'POST /v1/mandates/:id/decline':
      case 'POST /v1/mandates/:id/revoke':
        this.mandate(id).state = 'revoked';
        if (key.endsWith('revoke')) this.mandate(id).freezeStatus = 'requested';
        return json({ state: 'revoked' });
      case 'POST /v1/mandates/:id/pause':
        this.mandate(id).state = 'paused';
        return json({ state: 'paused' });
      case 'POST /v1/mandates/:id/resume':
        this.mandate(id).state = 'active';
        return json({ state: 'active' });
      case 'POST /v1/declarations': {
        const result = this.nextDeclaration ?? {
          declaration: { id: this.id('dcl') },
          predicted: { outcome: 'approve', reason_codes: ['OK_WITHIN_MANDATE'] },
        };
        this.nextDeclaration = null;
        return json(result, 201);
      }
      case 'POST /v1/agents/:id/purchase': {
        const next = this.nextPurchase;
        this.nextPurchase = null;
        if (next instanceof Error) return json({ error: 'issuer_timeout', message: next.message }, 504);
        const result = next ?? {
          issuer: 'airwallex',
          response_status: 'AUTHORIZED',
          status_reason: 'OK_WITHIN_MANDATE',
          card_transaction_event_id: this.id('evt'),
          challenge_id: null,
          decision: { outcome: 'APPROVE', reasonCode: 'OK_WITHIN_MANDATE' },
        };
        if (result.response_status === 'AUTHORIZED') {
          for (const mandate of this.mandates.values()) {
            if (mandate.state === 'active') mandate.spentMinor += Math.round(Number(body.amount) * 100);
          }
        }
        return json(result);
      }
      case 'GET /v1/decisions':
        return json(query.get('mandate_id') === null ? [] : this.decisions);
      case 'GET /v1/decisions/:id':
        return json({ eventId: id, latencyMs: 12 });
      case 'GET /v1/challenges':
        return json([...this.challenges.values()].filter((entry) => entry.status === query.get('status')));
      case 'GET /v1/challenges/:id': {
        const challenge = this.challenges.get(id);
        return challenge === undefined ? json({ error: 'not_found' }, 404) : json(challenge);
      }
      case 'POST /v1/challenges/:id/approve':
        defined(this.challenges.get(id), 'challenge').status = 'APPROVED';
        return json({ status: 'APPROVED' });
      case 'POST /v1/challenges/:id/deny':
        defined(this.challenges.get(id), 'challenge').status = 'DENIED';
        return json({ status: 'DENIED' });
      default:
        return json({ error: 'not_found', message: `${key} is not faked` }, 404);
    }
  }
}
