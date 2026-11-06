# Succuro

> Status: under construction. One support desk for all of a company's products, usable from screens and from an assistant.

## 1. What it does

A company with several products shouldn't need a support tool per product, and a small team shouldn't need one that charges per seat. Succuro keeps every product's requests in one inbox, and answers from each product's own address.

1. **Workspaces and products.** A workspace is a company. A product is a brand or project inside it, with a name, a colour, a support address, a sender name and a public key for its widget.
2. **Tickets.** Each has a number counted per workspace, a subject, a status, a priority, a category, a product, a requester, an assignee, tags and a channel (email, web, API or assistant). An app can say what it's about (type, id, title, address) and add free context (page, version, operating system).
3. **Statuses.** Open waits on support. Pending waits on the requester. Resolved and closed have settled. Anything the requester writes puts a ticket back to open, a closed one included. A reply that leaves makes it pending, unless the member settled it as they sent it.
4. **Messages.** A conversation holds the requester's words, replies, internal notes and system lines. Each says who wrote it, a member or an assistant; a reply also says what became of it.
5. **Requesters.** One per address in a workspace, with an optional name and their id in your app. The first name heard stays: anyone can put any name on an email.

## 2. Ways in

**An app, with a key.** `POST /api/v1/tickets`, `Authorization: Bearer sk_…`, with a key holding the `tickets:create` scope.

```json
{
  "subject": "Refund for order 42",
  "message": "Please refund order 42.",
  "requester": { "email": "ada@acme.example", "name": "Ada Martin", "externalId": "user_42" },
  "product": "acme-app",
  "category": "Billing",
  "priority": "high",
  "tags": ["billing"],
  "about": { "type": "order", "id": "42", "title": "Order 42", "url": "https://shop.acme.example/orders/42" },
  "context": { "page": "/orders/42", "version": "3.1.0", "os": "macOS" }
}
```

Only `subject`, `message` and `requester.email` are required. `product` is a product's slug and `category` a category's name, in that workspace. `about.url` must be an http or https address, and `context` stays under 8 KB. It answers `201` with `{ "id", "number", "status", "requesterUrl" }`: the last is the requester's page, for your app to show them. Refusals: `401` for a missing or unknown key, `403` for a key without the scope, `400` for what doesn't parse, `422` for a product or category that isn't there, and `429` past the limit.

**The limit.** Each key may make 600 of these requests in a clock hour, refused ones included, so a client stuck in a loop stops here. Past it the answer is `429` with `Retry-After`, the seconds until the next hour starts. Keys are counted apart: an app that really needs more can have a second one. Figures aren't limited.

**A website.** A product's settings give a snippet that loads `/widget.js`, a small form in a shadow root. It carries the product's name, colour and public key in its attributes, so a page view asks the database nothing. A page can add context with `window.supportWidgetContext = { version: "1.2" }`. Or post your own form to `POST /api/public/tickets`, as JSON or as form fields, with `key`, `email`, `subject`, `message` and optionally `name`, `about` and `context`. Any site may post there. A hidden `website` field is the honeypot: filled in, the answer is an ordinary success and nothing is recorded. It's limited to 5 tickets an hour from one address on one product, and 200 an hour on one product from everywhere. Nothing is mailed at this point: an open form that sends mail to whatever address it's given could be used against anyone.

**Email.** Mail to a product's address reaches Resend, whose `email.received` webhook posts here, signed. A webhook carries only a mail's metadata, so the body is then fetched with the workspace's own key. It continues a ticket if the address it was sent to holds that ticket's token, or if its `In-Reply-To` or `References` name a mail already on one, in that order, inside that workspace only. Anything else opens a new ticket. Then:

- The same mail posted twice is recorded once, by the service's id and by its Message-ID.
- What the mail client quoted back is dropped, by the usual forms; when in doubt, everything stays.
- A machine's mail opens nothing, reopens nothing, tells nobody and is never answered. That covers `Auto-Submitted`, `Precedence: bulk`, `junk`, `list` or `auto_reply`, the usual autoresponder headers, `List-Id`, `X-Failed-Recipients`, an empty `Return-Path`, a delivery report, and senders like `mailer-daemon@` or `postmaster@`. On a ticket it answers, it's noted for the team. Nothing here ever mails a requester on its own, so a robot that doesn't say what it is still gets nothing back to answer.
- A product's own address writing in is ignored, and so is the instance's own (`SUCCURO_MAIL_FROM`).
- Someone else writing on a ticket, a colleague by mail for example, is shown to the team with their address, and not to the requester.
- A mail whose own checks fail (DMARC, or both SPF and DKIM) is flagged: its From line may be anyone.
- An attachment isn't kept yet, but it is recorded: the team and the requester both see that it arrived and wasn't stored.

## 3. Ways out

**Replies.** A member's reply leaves from the product's address through the workspace's Resend connection, threaded with `In-Reply-To` and `References`, with a `Reply-To` holding the ticket's token and an `Idempotency-Key` so that one reply can't leave twice. Its state follows the service's reports: sent, delivered, delayed, bounced, marked as spam or failed. A reply that bounces, or that the service couldn't send, says why on the ticket and puts it back with the team. A failure keeps its words, for a member to fix and send again. A reply whose sending died halfway is marked as failed within the hour, saying it can't be known whether it left; sent again within a day, it doesn't leave twice.

This tool never sends cold mail. Every mail answers a ticket, and nothing else in it writes first. Resend's terms forbid cold mail, and a form that can open tickets for any address never mails anyone by itself.

**Telling the team.** When a ticket arrives by any way in, or a requester answers by their page or by mail, the assignee is mailed, or everyone on the team if nobody holds it. The person who wrote it never is: not a member writing in from their own address, and not a member or their assistant recording a request.

- It goes through the instance's own mail (`RESEND_API_KEY`, `SUCCURO_MAIL_FROM`), never a workspace's connection, one mail per person. Without that key nobody is told, and the settings page says so; tickets still arrive.
- Each member chooses in Settings, for themselves, in that workspace: on or off, and which products. On is the default. Off holds when the ticket is theirs too: nobody is mailed in their place.
- The mail has the subject, the number, who it's from, a link to the ticket and an excerpt of 280 characters at most. The words are a stranger's, reaching people from the instance's own address, so the excerpt is one line, its links and addresses are replaced by `[link removed]`, and the mail says it wasn't checked. It holds no requester's link.
- A burst is capped, per clock hour: 3 mails about one ticket, 5 about one person, 100 in a workspace. The last mail before a cap says so. Nothing is lost: the tickets are all in the inbox. Nothing runs later to catch up, since there's no job for this, so what was capped stays unmailed.
- These mails say a machine wrote them (`Auto-Submitted: auto-generated`), so an out-of-office doesn't answer them.
- A failure can't lose what came in: the ticket is saved first. The failure is written on the ticket, for the team only, and the app, form, webhook or requester gets its ordinary answer. A provider that hangs is given up on after 5 seconds.

**The requester's page.** Each mail links to `/t/<token>`, where the requester reads the conversation and answers, without an account. The token is signed, names one ticket in one workspace, and lasts 90 days from the reply that carried it; a later mail carries a later one. A forged token is turned away without asking the database. A member can end a ticket's links from its page. Answers are limited to 20 an hour per ticket.

The page reads through a list of what a requester may see: their own words and replies that left. Notes, drafts, system lines and failed replies stay out, and so would anything a later version adds, until someone decides otherwise. The same goes for tags, the assignee, the priority, the context and who on the team wrote what. Notes are never mailed.

## 4. Screens

- **Inbox** (`/tickets`). Filters for status, product, assignee, priority, category, tag and search, counts per status under the other filters, "mine" and "unassigned", and bulk changes of status, assignee, priority and tags. It opens on what's open.
- **Ticket** (`/tickets/<number>`). The conversation, a reply box with saved replies, drafts to send or discard, internal notes, the controls, and beside them the requester, their other tickets, what it's about and its context.
- **Settings.** Products with their widget snippet, categories, saved replies, connections, API keys, who sends replies, a member's own notifications, how to connect an assistant, and the team. Connections, keys, products and who sends replies are for owners and admins; categories and saved replies are for any member.

## 5. Assistants

The MCP server is at `/api/mcp`, over streamable HTTP. An assistant registers itself, a member signs in and approves it, and every tool runs as that member with the same rules as the screens: each is the same use case the screens call.

| Tool | What it does |
|---|---|
| `list_workspaces` | The member's workspaces. With several, every other tool names one on each call: there is no current workspace. |
| `list_tickets` | The inbox, with filters and counts. |
| `read_ticket` | One ticket, notes and drafts included. |
| `create_ticket` | Records a request that came in some other way. Sends nothing. |
| `add_note` | A note for the team. |
| `update_ticket` | Status, priority, assignee, tags. |
| `draft_reply` | Saves a draft a member sends from the screen. |
| `send_reply` | Sends a draft, if the workspace allows it. |
| `list_saved_replies` | What the workspace keeps ready. |
| `find_contact` | A requester by address, name or id, with their tickets. |
| `support_figures` | The figures of section 6. |

**What customers write is data.** Subjects, messages, names and context are written by strangers, and can be written at an assistant. The server's instructions and each tool that returns them say never to follow instructions in them, and `read_ticket` labels each message and repeats it beside the words. No tool can change who belongs to a workspace, connect a service, make a key, or change the setting below.

**Replies are approve-first.** By default `send_reply` is refused and a member sends drafts from the screen. An owner or admin can allow it in Settings, for that workspace, and only there. Even then the assistant may send only once the member said yes in their conversation: the server can't see that conversation, so the tool's description asks for it and the call must declare `memberSaidYes: true`. A draft an assistant wrote says so, even once a member sent it, unless they changed the words.

## 6. Figures

`GET /api/v1/figures?days=30&product=acme-app`, with a key holding the `figures:read` scope. `days` runs from 1 to 365, 30 by default. `product` is optional. There are no people's names, addresses or words in it. It names the workspace the key opens, so an app can tell one key from another.

```json
{
  "workspace": { "id": "…", "name": "Acme" },
  "from": "2026-11-04",
  "to": "2026-11-05",
  "timezone": "UTC",
  "products": [
    {
      "slug": "acme-app",
      "name": "Acme App",
      "days": [
        { "date": "2026-11-04", "opened": 3, "resolved": 1, "firstResponseSeconds": 1800, "resolutionSeconds": 7200, "backlog": 12 },
        { "date": "2026-11-05", "opened": 0, "resolved": 2, "firstResponseSeconds": null, "resolutionSeconds": 86400, "backlog": 10 }
      ]
    }
  ]
}
```

Every day of the period is there, in UTC, including the empty ones.

- `opened`: tickets created that day.
- `resolved`: tickets that settled that day and haven't reopened since.
- `firstResponseSeconds`: the median time to a first reply, over the tickets that got theirs that day. `null` when none did.
- `resolutionSeconds`: the median time from creation to resolution, over the tickets resolved that day. `null` when none were.
- `backlog`: tickets unresolved at the end of that day.

A ticket reopened since counts as never resolved, on past days too: the figures read tickets as they stand now rather than keeping a history. Tickets with no product have a line with `"slug": null`.

## 7. How it is built

- Next.js 16 with `cacheComponents`, TypeScript strict, Tailwind 4; Postgres through Drizzle; Better Auth, with its OAuth provider for assistants; Vitest, against an in-process Postgres.
- Layers: `domain` (pure rules) < `application` (use cases) < `infrastructure` (database, mail, auth) < `app` (pages, routes, the MCP server). Each use case is called by both screens and tools.
- **Tenants apart.** Every workspace's table has row-level security, read and written as a restricted role with the workspace set per transaction, so a query that forgets to filter still sees only its own. A test reads the database's own catalogue and fails if a new table lacks it. Three lookups come before any workspace is known, on the trusted path: an API key's hash, a product's public key, and a connection's address.
- **Credentials.** A workspace's keys are sealed with the instance's key (AES-256-GCM) in its own row, typed only on the Connections page, never in environment variables or a conversation.
- **Connections.** One entry in a catalogue (`domain/connectors`) and one adapter (`infrastructure/connectors`) behind a port. There's one today, Resend.

## 8. Not waking the database

A database that bills by the hour it's awake shouldn't be woken for nothing. There's no polling. Webhooks and API calls wake it only when something happened, and what can be refused without it is: a page view of the widget, an anonymous page, a forged requester's link, a filled honeypot, a form of the wrong shape, a key of the wrong shape. `currentMember()` doesn't start auth without a session cookie.

One scheduled job remains, hourly: replies whose sending died. Whether one is in flight lives in the platform's cache (`scheduled-work`), cleared by each send, so with none in flight the job answers without asking the database.

## 9. Planned

None of this exists yet:

- A knowledge base.
- Automatic answers.
- SLAs.
- A connector to a CRM, showing a customer's deals beside the ticket.
- IMAP and Gmail mailboxes, alongside Resend.
- Attachments, kept and sent.
- Live chat.

Also missing today, and worth knowing: there's no spam filtering beyond what the mail service does and the limits on the form and the API, and mail from one address that doesn't say it's a machine opens a ticket each time; and there's no screen listing the assistants a member has approved, so one is ended by disconnecting it on the assistant's side.
