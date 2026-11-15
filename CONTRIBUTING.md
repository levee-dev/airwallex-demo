# Contributing

Thanks for helping improve Acme Pay. It is a reference app, so changes should keep it small, readable and sandbox-only.

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Fork, branch from `main`, and follow the [quickstart](README.md#quickstart): `npm install`, then `npm run dev`, which sets up anything missing and serves the app on a Cloudflare quick tunnel (`npm run dev -- --no-tunnel` for localhost only).
3. Before you push, run `npm run lint`, `npm run typecheck` and `npm test` (with `TEST_DATABASE_URL` set to cover the Postgres suite).
4. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(server): …`, `fix(web): …`) and keep each pull request to one change, with tests for new behaviour.
5. Never commit credentials, real account ids or `.env` files.

Security issues go to security@levee.dev, not to the issue tracker; see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
