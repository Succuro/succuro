# Succuro

One support desk for all of a company's products, usable from screens and from an assistant (Claude or ChatGPT, through MCP). Tickets come in by email, by a form or widget on your site, and from your own apps through an API. Open source (AGPL-3.0), self-hostable, with no seats or credits. See [docs/00-product.md](docs/00-product.md).

**Under construction.** This is a first version. It works end to end on a test instance with a stand-in for its mail service, but it hasn't handled real mail yet, its data model may change, and it has no upgrade path between versions so far. Don't rely on it for production support yet.

## What works today

- **Several companies, several products.** Workspaces kept apart by Postgres row-level security, and products inside a workspace, each with its own address, sender name and widget.
- **Tickets in**: `POST /api/v1/tickets` with an API key (limited per key), a public form endpoint and an embeddable widget (rate limited, with a honeypot), and inbound email through Resend's signed webhook, matched to tickets by a token in the reply address and by `In-Reply-To`/`References`.
- **Replies out**: by email from the product's address through the workspace's own Resend connection, threaded, with delivery recorded and failures shown plainly. Each mail carries a link to a page where the requester reads and answers without an account.
- **Telling the team**: a mail to the assignee, or to everyone, when a ticket arrives or a requester answers, capped against bursts, with an off switch per member and per product.
- **Screens**: an inbox with filters, counts and bulk actions; a ticket page with the conversation, reply box, notes, saved replies and everything known about the request; settings for products, categories, saved replies, connections, keys and who may send.
- **Assistants**: an MCP server where replies are approve-first. An assistant drafts, a member sends, unless an owner or admin decides otherwise on the screen.
- **Figures**: `GET /api/v1/figures` per product and per day.

What isn't there yet is listed in [section 9 of the spec](docs/00-product.md#9-planned).

## Running it locally

You need Node 20 or later, pnpm and Postgres. Docker gives you one:

```bash
docker run -d --name succuro-db -e POSTGRES_PASSWORD=local -e POSTGRES_DB=succuro -p 127.0.0.1:5432:5432 postgres:17-alpine
pnpm install
cp .env.example .env.local   # then fill it in, SUCCURO_DATABASE_URL=postgres://postgres:local@localhost:5432/succuro
pnpm db:migrate
pnpm dev
```

Sign in needs one of the ways below. The quickest locally is `SUCCURO_PASSWORD_SIGN_IN=true` with `RESEND_API_KEY` set, and your address in `SUCCURO_ADMINS`.

Checks before committing: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`. Tests run against an in-process Postgres (PGlite) and need no database.

## Running your own

It's a Next.js 16 app and a Postgres database. `vercel.json` deploys it on Vercel with its functions in Frankfurt (`fra1`); anywhere that runs Node works too. Apply migrations with `pnpm db:migrate` before starting a new version.

Elsewhere than Vercel:

- Call `GET /api/cron/stuck-replies` hourly with `Authorization: Bearer <CRON_SECRET>`. With no reply in flight it answers without touching the database.
- What that job knows is kept with Next's `use cache: remote`. Without a [cache handler](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers) it lives in the server's memory: fine for one server, and it asks the database again after a restart.
- Put it behind a proxy that sets `X-Real-IP` or `X-Forwarded-For`. The form's limit per address reads them, and can be forged without a proxy that overwrites them. With neither, only the limit per form applies.

### Every environment variable

| Variable | Needed | What for |
|---|---|---|
| `SUCCURO_DATABASE_URL` | yes | Postgres. |
| `SUCCURO_DATABASE_URL_UNPOOLED` | no | The direct address, used by `pnpm db:migrate` when the main one goes through a pooler. |
| `BETTER_AUTH_SECRET` | yes | At least 32 characters (`openssl rand -base64 32`). Signs sessions and requesters' links: changing it signs everyone out and ends the links already sent. |
| `BETTER_AUTH_URL` | yes | The instance's public address. Links, webhooks and assistants' tokens are all built from it. |
| `SUCCURO_ADMINS` | yes, to get started | Comma-separated addresses that may sign up and start workspaces. Anyone else joins by invitation, from a workspace's settings. |
| `SUCCURO_SECRETS_KEY` | to connect mail | 32 random bytes, base64 (`openssl rand -base64 32`). Seals every connection's credentials. Keep it safe: without it they can't be opened, and owners have to connect again. |
| `SUCCURO_PASSWORD_SIGN_IN` | no | `true` allows addresses and passwords. Needs `RESEND_API_KEY`: sign-in stays closed until a mailed link proves the address. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | no | A company's identity provider, any OpenID Connect server, with `<your address>/api/auth/callback/oidc` as its redirect address. It must vouch for each address (`email_verified`), and it is then the only way in. |
| `OIDC_NAME` | no | That provider's name on the sign-in page. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | A Google OAuth app for signing in, with `<your address>/api/auth/callback/google` as its redirect address. |
| `RESEND_API_KEY` | no | The instance's own mail to its members: sign-in links, invitations and notifications about tickets. Without it, an invitation's link is shown to copy, and nobody is told about tickets, which the settings page says plainly. Replies to customers never use this key. |
| `SUCCURO_MAIL_FROM` | with `RESEND_API_KEY` | Who that mail is from. Mail coming back from this address is never taken as a ticket. |
| `CRON_SECRET` | for the job | The bearer the hourly job must be called with. Without it, the job refuses everyone. |

One of the ways to sign in has to be set: a company's provider, Google, or passwords.

A workspace's mail isn't configured here. An owner or admin connects it on the Connections page, where its key and signing secret are sealed in the workspace's own row.

## Connecting an assistant

The MCP server is at `/mcp`. Add that address to Claude, ChatGPT or any MCP client as a remote connector: the client registers itself, you sign in and approve it, and it acts inside your workspaces with their rules. If you belong to several, one connection covers them all and the assistant says which one on every call.

## License

Succuro is free software under the [GNU Affero General Public License v3.0](LICENSE): run it, study it, change it and share it; if you offer a modified version to others over a network, publish your changes under the same license.
