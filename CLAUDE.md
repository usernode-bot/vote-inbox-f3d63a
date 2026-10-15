# Vote Inbox — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the Press! example (the demo markup in
`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and
the `presses` table bootstrap in `server.js`) — is placeholder content
from the Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the `presses` table as appropriate,
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Vote Inbox

One inbox for all open proposals with vote counts. Vote fast, track mine.

The app is a client over the platform's own proposal APIs: it discovers
apps, lists each app's promoted (open) proposals via
`GET /api/apps/:slug/promoted`, and votes via `POST /api/sessions/:id/vote`,
always authenticated as the signed-in user by forwarding their iframe
token as a Bearer token. It keeps no proposal data of its own except the
user's vote history.

## App-specific conventions

- Local tables: `my_votes` (one person's vote history), `watchlist` (one
  person's starred proposals, plus the status each row was last seen in)
  and `my_proposals` (proposals composed in the app's New proposal screen
  — the platform's app-facing API is read-only, so a sent proposal is
  recorded here and the Sent list renders from it; nothing is submitted
  to any approval pipeline from this app) are all marked `staging:private`
  (per-person data). Proposal data stays on the platform — with one
  exception: the discussion thread.
- `proposal_comments` holds the discussion thread. It is PUBLIC (on
  purpose): comments are in-app content visible to every signed-in
  member, so a stranger seeing every row is fine. Nesting is one level
  only, enforced server-side at write time (a reply to a reply is
  filed under the reply's own top-level parent).
- Proposal detail view: the Discuss button on a card opens it, and
  `?proposal=<sessionId>` deep-links to it. Both work in production;
  the detail reuses the card's vote buttons via shared `proposalActions`.
- Demo thread hooks (staging demo only): `?comment=<text>` posts a
  top-level comment, `?reply-to=<id>&reply=<text>` posts a reply, both
  through the real form. Demo-4 carries fixture comments (negative ids
  -100..-102); demo-5 stays comment-free for the empty-state check.
  Demo comments live in server MEMORY, never the DB.
- Platform responses are normalised server-side (`normalizeProposal`) so
  the frontend deals with one shape; keep field-spelling tolerance there.
- `?demo=1` (staging only) serves obviously-fake fixture data for the
  Inbox, My Votes and Watchlist screens; production never serves demo data.
- Watchlist demo knobs (staging + `?demo=1` only): `?tab=watchlist` opens
  the Watchlist tab on the fixture rows; `?preset-star=<sessionId>` marks
  inbox cards starred for that load; `?tap-star=<sessionId>` taps a star
  button after render; `?set-star=<sessionId>` stars for real (a DB row for
  the signed-in account) then reloads, so persistence is observable — pair
  it with `?watch-mine=1` on the Watchlist tab to include those real rows;
  `?watch-seen=1` marks the fixture seen (no change badges) and
  `?watch-empty=1` empties the tab (the empty state).
- `?failvote=1` (demo only) makes the next vote cast on that load fail as
  if the device were offline, so the Retry-pill flow is reachable by
  checks. The retry queue lives in frontend memory only; it is never
  persisted.
- Compose check fixtures (demo only, one-shot, replayed through the real
  controls after the compose screen renders): `?compose=1` itself is a
  real deep link (all environments, not demo-gated); `&template=<id>`,
  `&switch-template=<id>`, `&set-title=<text>`, `&set-body=<text>` and
  `&send=1` walk one user path, and `&back=1` taps the compose screen's
  back chevron at the end of the chain. Check paths must URL-encode
  spaces (`%20`): the platform's test reader rejects paths with literal
  whitespace.
- `?splits=<sessionId>:<yes>-<no>,…` (demo only) overrides named fixture
  proposals' vote counts so the controversy sort's tie behaviour is
  reachable by checks without changing the default fixture's numbers.
- The Controversy sort (closest yes/no split first; unanimous or one-sided
  proposals sink; equal gaps break by title) ranks the whole loaded inbox,
  so it renders one flat list — the age-group headers only apply to the
  default and Newest sorts, where the day buckets are the point.
- Keep the inbox fetch bounded: parallel with concurrency limit 8 and a
  10 s overall budget, plus short TTL caches (apps 60 s, promoted 30 s).
