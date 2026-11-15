/** An in-memory stand-in for the Airwallex platform endpoints Acme calls. */
export class FakeAirwallex {
  readonly created: Record<string, unknown>[] = [];
  readonly accounts = new Map<string, string>();
  /** How many simulate calls fail before activation succeeds. */
  activationFailures = 0;
  rejectLogin = false;
  private counter = 0;

  readonly fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(input, init));

  private respond(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Response {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const reply = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    const path = url.pathname;
    if (path === '/api/v1/authentication/login') {
      return this.rejectLogin ? reply(401, { code: 'unauthorized' }) : reply(200, { token: 'awx_token_test' });
    }
    if (method === 'GET' && path === '/api/v1/accounts') return reply(200, { items: [] });
    if (method === 'POST' && path === '/api/v1/accounts/create') {
      this.counter += 1;
      const id = `acct_test_${this.counter}`;
      this.created.push(body as Record<string, unknown>);
      this.accounts.set(id, 'CREATED');
      return reply(201, { id, status: 'CREATED' });
    }
    const match = /^\/api\/v1\/(?:simulation\/)?accounts\/([^/]+)(?:\/(submit|update|update_status))?$/.exec(path);
    const id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (id === undefined || !this.accounts.has(id)) return reply(404, { code: 'not_found' });
    switch (match?.[2]) {
      case 'submit':
        this.accounts.set(id, 'SUBMITTED');
        return reply(200, { id, status: 'SUBMITTED' });
      case 'update_status':
        if (this.activationFailures > 0) {
          this.activationFailures -= 1;
          return reply(400, { code: 'still_processing' });
        }
        this.accounts.set(id, 'ACTIVE');
        return reply(200, { id, status: 'ACTIVE' });
      default:
        return reply(200, { id, status: this.accounts.get(id) });
    }
  }
}
