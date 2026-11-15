# Acme Pay

Acme Pay is a reference consumer fintech built on [Airwallex Issuing](https://www.airwallex.com/docs/issuing/overview) in which every purchase an AI agent makes is authorized by [Levee](https://levee.dev). A person signs up, gets their own Airwallex connected account, and connects an agent over MCP; the agent asks for a spending mandate, the person approves it with a passkey, and from then on each card authorization is decided by Levee through Airwallex Remote Authorization. Acme Pay itself never decides whether a payment goes through.

Everything runs against sandboxes. No real money moves.

```mermaid
flowchart LR
    agent["AI agent<br/>(Claude, Cursor, …)"]
    person["Person<br/>(browser + passkey)"]
    acme["Acme Pay<br/>MCP server + web app"]
    levee["Levee<br/>mandates, declarations, decisions"]
    awx["Airwallex Issuing<br/>sandbox card"]

    agent -- "MCP tools (bearer token)" --> acme
    person -- "approves mandates and step-ups" --> acme
    acme -- "mandate, signed declaration, purchase" --> levee
    levee -- "sandbox card transaction" --> awx
    awx -- "Remote Authorization request" --> levee
    levee -- "approve / decline" --> awx
    levee -- "signed webhooks" --> acme
```

## Prerequisites

- Node.js 22.9 or later
- Docker, for Postgres (or any Postgres 17 you point `DATABASE_URL` at)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the public dev URL (`brew install cloudflared`, `winget install --id Cloudflare.cloudflared`); no Cloudflare account needed
- An Airwallex sandbox account with **Issuing** and **Connected Accounts** enabled, and an API client ID and key
- A Levee sandbox account from <https://sandbox.levee.dev>: a tenant id (`ten_…`) and a platform key (`sk_test_…`)

## Quickstart

```sh
git clone https://github.com/levee-dev/airwallex-demo.git && cd airwallex-demo
npm install
npm run dev
```

`npm run dev` checks each prerequisite in turn and asks only for what is missing:

1. **`.env`**: offers to create it from `.env.example` with a fresh `ACME_ENCRYPTION_KEY`.
2. **Postgres**: if `DATABASE_URL` is not reachable, offers to run `docker compose up -d db` and waits for it.
3. **Migrations**: applied automatically.
4. **Credentials**: the first time, asks for the Levee and Airwallex sandbox values (secrets without echo), verifies them and stores them encrypted. It does not ask again once they are stored.
5. **Tunnel**: starts a Cloudflare quick tunnel and uses its `https://….trycloudflare.com` origin as the app's public URL for the run. It registers `<tunnel>/webhooks/levee` with Levee (reusing the endpoint when the URL has not changed) and points the tenant's passkey domain (RP ID and origins) at the tunnel host.
6. **Dev servers**: runs the API and Vite, then prints a summary with **Open Acme at https://….trycloudflare.com**.

The tunnel serves the whole app on one origin (web UI, API, MCP and webhooks), so sign-in cookies, approval links and the MCP URL shown when you connect an agent all use it. Ctrl-C stops everything.

**The tunnel URL changes on every run.** Passkeys are bound to it, so a passkey created on one run does not work on the next: sign up again or add a new passkey after a restart. The run repoints the tenant's passkey domain each time, so use a Levee sandbox tenant set aside for local development.

### Demo on your phone

Run `npm run dev` and open the printed URL on your desktop and on your phone. Sign in on both, connect the agent on the desktop, and approve mandates and step-ups with the passkey on your phone.

### Without a tunnel, and in CI

`npm run dev -- --no-tunnel` serves on <http://localhost:5173> only. Levee cannot deliver webhooks to localhost, so mandate and purchase updates arrive only when Acme reads them back from Levee.

Without a terminal (CI, scripts) `npm run dev` never prompts. Put everything in the environment or `.env`: `DATABASE_URL`, `ACME_ENCRYPTION_KEY` and, on first run, the `ACME_SETUP_*` credentials. When something is missing it stops and names the variables to set; without cloudflared it asks you to install it or pass `--no-tunnel`.

### Deploying

For a real deployment, run the steps yourself: `npm run db:migrate`, then `npm run setup` (prompts, or reads the `ACME_SETUP_*` variables, and also takes the webhook signing secret of the endpoint you register in the Levee console at `<ACME_PUBLIC_URL>/webhooks/levee`), then `npm run build` and `npm start`. `npm run acme -- status` shows what is configured, including the registered webhook URL, the passkey RP ID and whether phone notifications are set up, without printing secrets. Setup also generates the Web Push (VAPID) key pair for phone notifications, once, and stores it encrypted; later runs keep it so existing subscriptions stay valid.

### Passkey RP ID

Passkeys are bound to a relying party ID, a hostname the app's origin sits under. `npm run setup` sets the Levee tenant's RP ID to the host of `ACME_PUBLIC_URL` and its passkey origins to that origin (Android app origins are kept). Set `ACME_PASSKEY_RP_ID` to use a parent domain instead (for `https://pay.example.com`, `example.com`); it must be the host itself or a registrable suffix of it, never an IP address or a public suffix such as `trycloudflare.com`. Levee does not accept `localhost` on production tenants, so use a public HTTPS URL there. (`npm run dev` leaves this to its tunnel step, which points the RP ID at each run's tunnel host.)

If the tenant already has a different RP ID, every passkey registered under it stops working after the change, and their owners have to add a new one. Setup asks before changing it; run unattended, it refuses unless you pass `--force-rp-id` (`npm run setup -- --force-rp-id`).

## Connecting an agent

Sign up at the URL `npm run dev` prints and finish onboarding: **Account → Passkey → Phone → Agent**. Your own Airwallex card account opens in the background as soon as you sign up, so there is nothing to wait for; a pill on the passkey, phone and agent steps and on the dashboard shows "Opening card account…", "Card account ready", or "Couldn't open card account · Retry". Provisioning is idempotent and resumes where it stopped: it retries Airwallex's sandbox activation with backoff, and an account left `SUBMITTED` is picked up on the next status read. Approving a mandate, which issues the agent's card, waits until the account is ready.

On the passkey step, **Use my phone** creates the passkey on your phone instead of this computer: Chrome shows a QR code to scan (Bluetooth on for both devices). The phone step is optional; see [Phone notifications](#phone-notifications).

Then connect an agent. Acme shows the agent's token once, with a ready-made config for your client that uses the app's current URL. For Claude Desktop (`claude_desktop_config.json`) it looks like this:

```json
{
  "mcpServers": {
    "acme-pay": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-tunnel>.trycloudflare.com/mcp",
        "--header",
        "Authorization:${ACME_AUTH}"
      ],
      "env": { "ACME_AUTH": "Bearer <agent token>" }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`) and other clients that speak Streamable HTTP can connect directly:

```json
{
  "mcpServers": {
    "acme-pay": {
      "url": "https://<your-tunnel>.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}
```

Codex (the CLI, IDE extension and desktop app share `~/.codex/config.toml`) connects over Streamable HTTP too:

```toml
[mcp_servers.acme-pay]
url = "https://<your-tunnel>.trycloudflare.com/mcp"
http_headers = { Authorization = "Bearer <agent token>" }
```

To keep the token out of the file, use `bearer_token_env_var = "ACME_PAY_TOKEN"` instead of `http_headers` and export `ACME_PAY_TOKEN` before starting Codex. Run `/mcp` in Codex to check the server is connected.

The agent gets five tools: `acme_request_mandate`, `acme_request_status`, `acme_list_mandates`, `acme_purchase` and `acme_purchase_status`.

## A purchase, end to end

1. **Ask.** You tell the agent "buy me a USB-C hub, up to $40, this week". It calls `acme_request_mandate` with a cap, a category (`electronics`), a window and your words as the purpose, and shows you the approval link it gets back.
2. **Approve.** The link opens Acme Pay. You review the cap, categories, stores and window, and approve with your passkey. Levee records the mandate and issues the agent's card on your connected account.
3. **Buy.** The agent calls `acme_purchase` with the merchant, the price and what it is buying. Acme resolves the merchant, signs a declaration with the agent's Ed25519 key and sends it to Levee. When Levee allows it, the sandbox card is swiped.
4. **Decide.** Airwallex sends the authorization to Levee over Remote Authorization; Levee approves or declines it against the mandate. A first purchase from a new store, or anything outside the mandate, comes back as `approval_required` with a link for a passkey step-up.
5. **Settle.** The agent polls `acme_purchase_status` until the result is final. Levee's webhooks keep Acme's records in step, and the dashboard shows every mandate, purchase and pending approval. You can pause or revoke a mandate there at any time.

## Phone notifications

Acme Pay is an installable web app. When your agent asks for a mandate, or a purchase needs your OK, Acme sends a Web Push notification to every device you enabled; tapping it opens the approval page. Sending is fire and forget, so a push failure never holds up a webhook, and subscriptions the push service reports gone (404 or 410) are deleted.

Phones can only reach the app on a public HTTPS URL, so run `npm run dev`, which serves it on a Cloudflare tunnel, and open the printed URL. The phone step shows a QR code of the app's public URL (from the server's configuration). It opens sign-in on the phone and carries no credential, so a photo of the screen gives nothing away. On iPhone, add Acme Pay to the Home Screen first (Share → Add to Home Screen) and open it from there: iOS only delivers Web Push to Home Screen apps. Then tap **Allow notifications** and **Send test notification**. The step can be skipped; the dashboard keeps an "Enable phone notifications" reminder until a device is on.

## Project layout

```
server/             Hono API, MCP endpoint and webhook receiver (TypeScript, Drizzle, Postgres)
  src/              accounts, auth, passkeys, push, agents, mandates, purchases, approvals, mcp, webhooks, levee, airwallex
  scripts/acme.ts   operator CLI: migrate, setup, status, and dev (what `npm run dev` runs)
  drizzle/          SQL migrations
  test/             unit suites (in-memory Postgres via PGlite) and a real-Postgres integration suite
web/                React 19 + Vite app: sign-in, onboarding, dashboard, approval pages; PWA manifest and service worker
docker-compose.yml  Postgres 17 for development and tests
```

In production (`NODE_ENV=production`), `npm run build` builds the web app and `npm start` serves it from the same origin as the API. `GET /api/health` answers `{ "ok": true }`.

## Testing

```sh
npm test            # unit suites, plus the Postgres suite when TEST_DATABASE_URL is reachable
npm run lint        # ESLint (server, web and tests) and Prettier
npm run typecheck   # tsc for server and web
```

The unit suites run against PGlite with in-memory stand-ins for Levee and Airwallex, so they need no network or credentials. The integration suite creates and drops its own database on the server named by `TEST_DATABASE_URL` (for example `postgres://acme:acme@localhost:5432/postgres` after `docker compose up -d db`) and is skipped when it is unset.

## Security notes

- Acme Pay only talks to sandboxes: `AIRWALLEX_BASE_URL` must be an Airwallex sandbox host and setup accepts only `sk_test_` Levee keys.
- Platform credentials and the Web Push private key are stored encrypted with AES-256-GCM under `ACME_ENCRYPTION_KEY`; error messages and logs name variables, never their values.
- Sessions use httpOnly cookies with a CSRF token on every unsafe request; the database keeps only hashes of session and agent tokens.
- Webhooks are verified with an HMAC over the raw body within a five-minute window (with the setup secret or the dev tunnel endpoint's) and de-duplicated by event id, and Acme re-reads state from Levee rather than trusting an event's payload.
- Every declaration carries the agent's Ed25519 signature over RFC 8785 canonical JSON. The optional decision model (`SYSTEM_ONE_*`) can only stop or narrow a request, never approve one.
- This is reference code for sandboxes, not a production banking app. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[Apache-2.0](LICENSE)
