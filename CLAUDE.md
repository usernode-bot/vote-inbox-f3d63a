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

- Local tables: `my_votes` (one person's vote history) and
  `watchlist` (one person's starred proposals, plus the status each row
  was last seen in) are both marked `staging:private` (per-person data).
  `saved_searches` (one person's saved inbox searches: name, query,
  filters, last-seen stamp) is the third private table, and `snoozes`
  (one person's snoozed proposals and their wake dates) is a fourth,
  also `staging:private`. `proposal_reads` (one person's opened proposals:
  append-only session-id rows) is the fifth, also `staging:private`, and
  `bookmarks` (one person's bookmarked proposals: app, title, saved date)
  is the sixth, also `staging:private`. `my_proposals` (proposals composed
  in the app's New proposal screen — the platform's app-facing API is
  read-only, so a sent proposal is recorded here and the Sent list renders
  from it; nothing is submitted to any approval pipeline from this app) is
  the seventh, also `staging:private`.
  Proposal data stays on the platform — with one exception: the discussion
  thread.
- Bookmarks: the Bookmark button on every proposal card and in the
  detail's action bar saves a proposal to the person's Saved tab (next to
  Inbox, My Votes and Watchlist; badge shows the row count, hidden at
  zero). Saving is per member (a `bookmarks` row keyed by user id, so it
  survives reloads and follows the account); un-bookmarking removes the
  row at once, optimistically on the client with a rollback on failure
  (same pattern as stars and votes). The button is a quiet ghost pill —
  "Bookmark" idle, violet "Bookmarked" saved — independent of starring,
  voting and snoozing, and works on voted and merged proposals too.
  Cards show the saved date on Saved rows ("Saved 5 Oct"); the tab's
  summary line reads "N saved, M settled" (settled = merged or closed,
  from the row's own status when the server supplies one, else from the
  loaded inbox data — no extra platform calls). The empty state says
  "Nothing saved yet" with a Browse apps button like the inbox's.
  Demo knobs (staging + `?demo=1` only): `?tab=saved` opens the tab on
  two fixture rows (demo-5 saved 6 days ago, demo-6 2 days ago); the
  inbox demo load stamps `myBookmark` onto cards like stars (from the
  caller's real rows, or `?preset-bookmark=<id>` display-only); saving
  through the demo route stores a real row for the signed-in account so
  persistence is observable. Hooks, all through the real buttons or
  routes: `?tap-bookmark=<id>` (clears that proposal's stored row first,
  then taps the card's button); `?set-bookmark=<id>` (saves for real then
  reloads without the param — pair with `?tab=saved`, which turns on
  `?saved-mine=` on the reload so the persisted row is listed);
  `?tap-unbookmark=<id>` (taps the button from a bookmarked render; pair
  with `?preset-bookmark=<same id>` on the inbox, or use it directly on
  the Saved tab where the fixture rows render bookmarked);
  `?saved-empty=1` empties the Saved tab (the empty state); and
  `?saved-other=1` stores a bookmark for a fake member (staging-demo-user
  on demo-4) after resetting the caller's rows on the six fixture ids, so
  the per-member check sees the caller's list without it. `set-bookmark`,
  `tap-bookmark` and `saved-other` all reset the caller's fixture rows
  first, so repeated check runs start clean.
- Read tracking: opening a proposal (Discuss, or a `?proposal=` deep link)
  marks it read for the signed-in account only — an append-only row in
  `proposal_reads`, so read state survives reloads, follows the account and
  never unreads. Unread cards show a violet dot before the title (inbox
  cards only, not the detail); the header's unread line counts loaded
  proposals minus snoozed ones and ignores every filter, with a Mark all
  read button beside it (hidden at zero); a Hide read switch next to Hide
  voted / Hide merged tucks opened proposals away (persists in
  `vote-inbox:hide-read`, like Hide voted). The server stamps the caller's
  read set onto `/api/inbox` in production; on demo loads it only rides
  along when the fetch carries `?read=1` (the same opt-in rule as the
  snooze overlay), so a plain `?demo=1` load stays all-unread. Demo hooks
  (staging + `?demo=1` only): `?tap-open=<id>` clicks a card's Discuss and
  the detail's Back; `?set-read=<id>` does the same but reloads at a
  `?read-set=<id|all>` marker whose fetch carries `?read=1`;
  `?markallread=1` clicks Mark all read then reloads at `read-set=all`;
  `?open-merged=1` opens the merged fixture (demo-5) the deep-link way;
  `?read-other=1` seeds a fake member's read row on demo-3 for the
  per-user check; `?tap-hide-read=1` taps the Hide read switch. Any of
  `set-read`/`markallread`/`open-merged`/`read-other` first resets the
  caller's rows on the six fixture ids, so checks never depend on earlier
  runs.
- New since last visit: every successful inbox load saves the newest loaded
  proposal (`{ id, at proposedAt }`) to localStorage
  `vote-inbox:newest-seen` — per device and browser, like the Hide voted
  switch — and resolves it into a baseline time (the remembered proposal's
  own time when still loaded, else the stored stamp). Cards proposed after
  that baseline show a small violet "New" badge (`data-new-badge`,
  aria-label "New since your last visit") beside the title, right after the
  unread dot; badges persist across re-renders and clear on the next fetch.
  First visit, blocked storage, a missing proposed date or a zero-proposal
  load marks nothing New. Demo hook (staging + `?demo=1` only, client-only,
  nothing forwarded): `?newbadge=1` sets the baseline to the demo-6 fixture,
  so demo-2 and demo-4 read as New and a later plain `?demo=1` load stays
  badge-free.
- Snooze: each person can snooze a proposal for one day or one week from
  the card's Snooze button, so it leaves their inbox until its wake date
  and reappears automatically after it (expiry is lazy: rows whose wake
  date has passed are deleted on read, no sweeper). Snooze is purely a
  per-user inbox-view concern — it never touches votes, stars or merge
  behaviour, and the header totals keep counting snoozed proposals. The
  Snoozed chip/filter (`?snoozed=1` deep links to it, works in
  production) lists snoozed rows with their wake dates and an Unsnooze
  button that returns the proposal immediately; unsnoozing the last one
  returns to the inbox, and an all-snoozed inbox gets its own empty
  state pointing at the filter.
- App following: each app row in the app filter carries a star toggle
  (aria-pressed); following an app (persisted in localStorage
  `vote-inbox:follows`) adds it to the Following tab, which groups the
  followed apps' open (non-merged) proposals per app with a summary line
  ("N open, M votes needed" via `data-following-needed` / `data-following-apps`)
  and a tab badge. Unfollowing removes the star and the app's group. An app
  with no open proposals renders no group; a followed proposal counts as
  needing a vote until it is voted or merged. The Inbox is untouched.
  Following demo hooks (staging + `?demo=1` only): `?set-follow=<slug,slug>`
  replaces the caller's followed set (reloads at `clear-set-follow=1`, the
  same pattern as set-filter); `?clear-follows=1` empties it for that load;
  `?tap-follow=<slug>` / `?tap-unfollow=<slug>` tap the star through the real
  delegated handler (boot-time storage adjust makes the tap act from the
  intended direction).
- Snooze demo hooks (staging + `?demo=1` only): `?tap-snooze=<id>` opens
  that card's snooze menu; `?set-snooze=<id>&snooze-days=1|7` snoozes for
  real (a DB row for the signed-in account) then reloads at a
  `?snooze-set=<id>` marker URL, so what a check sees is the persisted
  state; `?tap-unsnooze=<id>` taps a snoozed row's Unsnooze button;
  `?snooze-past=<id>` inserts an already-expired row for the caller on
  that fixture (the auto-reappear path); `?snooze-other=1` inserts an
  active row for a fake user on demo-3 (the per-user path); `?snooze=1`
  opts the demo inbox into overlaying the caller's persisted rows
  (mirrors the my_votes precedent — the default demo stays deterministic).
- Merge celebrations: when a proposal the user voted on is seen merged
  (within the last seven calendar days), a one-time card appears at the top
  of the inbox — what merged, on which app, and "You voted yes/no" (the
  choice recorded at detection time, so it never changes). Detection runs
  on every `/api/inbox` load server-side (`syncMergeCelebrations`) and
  writes one row per (user, proposal) to `merge_celebrations`
  (`staging:private`, like the other per-person tables); cards render from
  the payload's pending list (unseen, undismissed rows, newest first, so
  multiple merges stack as separate cards), and the first render marks them
  shown via `POST /api/celebrations/shown` — so each card shows once and
  never comes back. A failed shown-mark leaves the rows pending (the card
  returns on the next load). The card's Dismiss button removes it at once
  (optimistic, restored on failure) and marks the row dismissed via
  `POST /api/celebrations/dismiss`, so the proposal never celebrates again;
  the "See what merged" link opens My Votes filtered to merged this week.
  Only proposals the user actually voted on celebrate; the seven-day window
  (`CELEBRATION_MERGE_WINDOW_MS`) means older merges never surface. The
  cards' entrance animation is guarded by both `prefers-reduced-motion: reduce`
  and a `data-motion` attribute the page computes from the device setting.
- My Votes "merged this week" filter: a chip on the votes tab (same row as
  the vote order pill), on when `?votes-merged=1` — a real deep link that
  works in production (the celebration card's See-what-merged link sets
  it). Filters the loaded vote rows to those whose proposal merged within
  seven calendar days (recorded `merged_at`, falling back to `updated_at`,
  the same stand-in the row's merged date uses); not persisted, and a
  filtered-none result gets its own empty state with a Show all votes link.
- Celebration demo hooks (staging + `?demo=1` only; the plain demo payload
  always carries `celebrations: []` so the default stays deterministic):
  `?celeb=1` opts the load into the celebration path (fixtures + the real
  detection pass + the caller's pending cards); `?celebvote=<ids>` marks
  those fixture proposals voted by the caller (unvoted ones count as yes)
  and merged 24h ago, re-arming their rows to unseen on every such load;
  `?celeb-clear=1` empties the caller's celebration rows first, so repeated
  check runs start clean (checks sharing a fixture id with a concurrent
  sibling re-arm each other's rows, which is why the shown-once check omits
  it and uses demo-2, an id no other celebration check names);
  `?celeb-reload=1` marks the rendered cards shown (the real POST) then
  reloads a clean `?demo=1&celeb=1` URL, so the check observes that a shown
  celebration does not come back;
  `?celeb-tap-dismiss=<id>` taps that card's Dismiss button after render;
  `?celeb-tap-see=1` taps the card's See-what-merged link after render (the
  real click path to the votes filter); `?celeb-motion=reduced` forces the
  reduced-motion presentation (the way `?impact-mobile=1` forces the
  small-screen impact panel).
- `proposal_comments` holds the discussion thread. It is PUBLIC (on
  purpose): comments are in-app content visible to every signed-in
  member, so a stranger seeing every row is fine. Nesting is one level
  only, enforced server-side at write time (a reply to a reply is
  filed under the reply's own top-level parent).
- Proposal detail view: the Discuss button on a card opens it, and
  `?proposal=<sessionId>` deep-links to it. Both work in production;
  the detail reuses the card's vote buttons via shared `proposalActions`
  (see the "Proposal detail screen" bullet below for the full screen).
- Members directory: the header Members button toggles it over the
  current tab, and `?members=1` deep-links to it (works in production).
  Data comes from the platform `/members` API (creator first = owner
  chip) enriched server-side with per-username vote counts aggregated
  from `my_votes`; joined date and accepted-proposal count pass through
  whatever the platform supplies and stay absent otherwise (no
  placeholder). `?member-query=<text>` (staging demo only) presets the
  search box so the filter and no-match states are check-reachable.
- Monthly recap: a summary of the previous calendar month over the
  current tab, opened by the header menu's Monthly recap item (the menu
  button sits beside the Members button) or the My Votes tab's Monthly
  recap entry row; `?recap=1` deep-links to it (works in production).
  Data comes from `GET /api/recap`, computed server-side from the
  caller's `my_votes` history for the previous month (relative to
  `req.now`): votes cast, proposals merged, acceptance rate (the share
  of the month's votes whose proposal merged), most active app by vote
  count, and week chunks (days 1-7, 8-14, …) that feed the weekly rows
  and the small trend line. Rank movement has no platform API, so only
  the demo fixture carries it; in production the field is null and the
  row does not render (the optional-field contract). The view stamps
  `data-recap-prev-month="1"` when the server's month really is the one
  before now, so a wrong-month bug fails the check instead of rendering.
  Recap demo hooks (staging + `?demo=1` only): `?recap-empty=1` serves a
  no-activity month (the empty state); `?openmenu=1` opens the header
  menu on load (pure UI state, honoured without demo too);
  `?tap-recap=1` clicks the menu's Monthly recap item (pair with
  `?openmenu=1`); `?tap-recap-entry=1` clicks the My Votes tab's recap
  entry once the list has rendered; `?tap-recap-share=1` clicks the
  recap view's share button (pair with `?share=copy` for the
  deterministic Copied! state). The share button reuses the card share
  flow, so `?share=copy|sheet` forces its path the same way.
  Acceptance rate and the week buckets are computed from `my_votes` as
  it stands today, so a month's numbers can still move while its
  proposals are unresolved; merged means `status = 'merged'` at read
  time.
- Demo thread hooks (staging demo only): `?comment=<text>` posts a
  top-level comment, `?reply-to=<id>&reply=<text>` posts a reply, both
  through the real form. Demo-4 carries fixture comments (negative ids
  -100..-102); demo-5 stays comment-free for the empty-state check.
  Demo comments live in server MEMORY, never the DB.
- Platform responses are normalised server-side (`normalizeProposal`) so
  the frontend deals with one shape; keep field-spelling tolerance there.
- `?demo=1` (staging only) serves obviously-fake fixture data for the
  Inbox, My Votes and Watchlist screens; production never serves demo data.
- Saved-searches demo hooks (staging + `?demo=1` only, all through the real
  functions): `?seed-searches=A,B` replaces the caller's saved searches with
  the `SAVED_SEARCH_SEEDS` fixtures (`Weekly` matches demo-2 → unread 1;
  `All demo` matches all six → unread 3: demo-1 is newer but voted, demo-3
  and demo-5 are older than the 3-day seed stamp), `none` empties the list.
  `?savesearch=<name>` (repeatable) saves the current screen's query +
  filters — an empty value tests the name fallback; `?delsearch=<name>`
  deletes; `?tap-search=<name>` clicks the chip once inbox + list have
  loaded; `?search-reload=1` reloads a clean URL (drops the hooks and `q`).
  Seeded rows are real DB rows for the signed-in account, stamped 3 days
  back, so every check run starts from a known list.
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
- Onboarding tour: a three-step panel (what a proposal is, how to vote,
  where My Votes lives) shown to first-time visitors. It renders in its own
  `#tour-slot` above `#view` (never inside the list, so the cards'
  structure, the `#view > …:first-child` selectors and the first card's
  vote buttons are untouched), advances with Next, and Skip dismisses it at
  any step. Finishing OR skipping sets `vote-inbox:tour-done` in
  localStorage, so it never shows again on a later visit; the header menu
  button's "Show the tour" item reopens it (restarts at step 1 on the
  inbox tab; the flag stays set). Tour hooks (staging + `?demo=1` only,
  all through the real buttons): `?tour=1` forces the tour up past the
  flag; `?tour-reset=1` clears the flag so the load is a first visit
  again; `?tap-tour-next=<n>` taps Next n times after render;
  `?tap-tour-skip=1` taps Skip after those taps (skipping mid-tour);
  `?finish-tour=1` / `?skip-tour=1` drive the tour to done through the
  real buttons then reload a clean `?tour-done=1` marker URL, so what a
  check sees is the persisted state; `?tap-tour-open=1` marks the tour
  done first, then taps the header menu and its item, so the reopen path
  is what brings it back.
- Real empty states: the genuinely empty inbox (zero loaded proposals, no
  filter active) shows "Nothing to vote on yet" with a Browse apps button
  that opens the app filter dropdown (the empty fixture keeps its app list
  so the dropdown is populated). Header summaries now show at zero once a
  tab's data has loaded instead of hiding: "0 open, 0 votes needed",
  "0 voted, 0 merged", "0 starred, 0 updated". Demo knobs (staging +
  `?demo=1` only): `?empty=1` (forwarded to /api/inbox) empties the inbox
  fixture's proposals; `?votes-empty=1` (forwarded to /api/my-votes)
  empties the My Votes fixture.
- Bulk triage hooks (demo only) drive select mode and the bulk actions
  through the real code paths for checks: `?selectmode=1`,
  `?select=<ids>`, `?deselect=<ids>`, `?clearsel=1`, `?exitsel=1`,
  `?filter=<slug>` and `?bulk=approve|hide`. Sessions named by
  `?select=` are un-voted first, so repeated check runs against a shared
  staging database always start from unvoted cards. Selection lives in
  frontend memory only and is never persisted.
- Change-summary row on cards: `normalizeProposal` passes through `summary`
  (from `summary_md`/`summary`/`description` spellings, trimmed, capped at
  4000 chars) and `filesChanged` (from `files_changed`/`changed_files` — an
  integer or an array of names, whose length is used) as optional fields;
  `null` means the row or count simply does not render (no placeholder). The
  demo fixtures (`DEMO_CHANGE_SUMMARIES` in `server.js`) cover clamp, plural,
  singular, summary-only, count-only and neither. Demo hooks (staging +
  `?demo=1` only): `?expand-summary=<sessionId>` presets a card's summary
  open, `?tap-summary=<sessionId>` taps the line after render (the real
  click path); paired they show collapsing. Expansion state is per card in
  frontend memory only.
- Proposal tags: a fixed list only (`bug`, `feature`, `copy`, `ux`) —
  `normalizeProposal` reads them from `tags`/`labels` (array of names or one
  comma-separated string), lowercases, de-duplicates and drops anything
  outside the list, so chips and the tag filter always agree on what exists.
  Cards show at most two chips (the active filter tag first, then fixture
  order). The header tag filter combines with the app filter, persists in
  `localStorage` (`vote-inbox:tag-filter`, validated against the list) and
  shows each tag's open count: merged/closed proposals and voted proposals
  are excluded regardless of the hide toggles (same rule as the app
  filter's counts). Saved views neither capture nor clear the tag filter.
  Demo hooks (staging + `?demo=1` only): `?opentagfilter=1` opens the
  dropdown; `?tap-tag=<tag|all>` taps a row after render, and a real tag
  schedules one cleanup reload (`clear-set-tag=1`) that restores the same
  state from storage then empties it, so check runs don't leak the
  preference; `?set-tag=<tag>` sets the filter for real (like set-filter,
  reloads with `clear-set-tag=1`); tapping "all" stores nothing so no
  reload. Demo fixtures: bug 2, feature 2, copy 1, ux 1 open (demo-1 is
  voted, demo-5 merged, demo-3 untagged — those three are the absence and
  hidden-count assertions).
- Share as image (My Votes): a "Share as image" pill at the end of the
  Sort row draws a fixed 1200×630 summary card (handle, votes this week,
  merged count, top apps — the apps section omitted entirely when there
  are no votes) onto a canvas using the resolved theme colours, previews
  it above the votes, and opens the native share sheet with the PNG;
  without a share sheet it offers Download ("Image saved") and Copy link
  ("Copied!", same pattern as the card share button), and a render
  failure shows "Could not make the image. Please try again." Stats come
  from the loaded my-votes rows and the handle from the `/api/my-votes`
  `username` field; nothing is persisted. Demo hooks (staging + `?demo=1`
  only): `?shareimg=sheet|fallback|error` forces the path (error throws
  through the real draw), `?tap-shareimg=1|share|download|copy` taps the
  button then that panel action, `?shareimg-theme=dark|light` pins the
  theme for the draw, and `?no-votes=1` empties the demo votes fixture.
- `?turnout-refresh=1` (demo only) reloads the inbox through the real
  refresh path with the fetch carrying `?turnoutalt=1`, which the server
  answers with a variant fixture (two more proposals merged), so the app
  filter's per-app open and merged-this-week counts are observable
  updating in place.
- Weekly digest card on My Votes: computed entirely in the browser from
  `state.votes.votes` (no server totals), so its numbers always match the
  list below. Shows votes this week (calendar week, Monday start, viewer's
  local time), how many of them merged (same `status === 'merged'` rule as
  the summary line), a streak of consecutive weeks ending with this one
  that had at least one vote (the tile is left out entirely when it is
  zero), up to three top apps (count desc, ties alphabetical), an
  "Up/Down from N last week" / "Same as last week" line, and a View
  details toggle opening a seven-day bar chart (plain flex bars, zero
  votes = zero-height bar). Hidden while loading/error/empty/Members view;
  the card sits outside `#view` so existing row-position checks keep
  passing. A successful vote updates the history in place
  (`upsertLocalVote`/`removeLocalVote` instead of dropping
  `state.votes`), so the card updates without a reload. Demo hooks
  (staging + `?demo=1` only): `?digest=week|quiet` serves the digest
  fixture rows (server `demoDigestRows`, re-stamped client-side by
  `reanchorDigestDemo` from `demo_anchor { weeksAgo, weekday }`), 
  `?digest-details=1` taps the View details toggle after render, and
  `?digest-vote=<sessionId>:<yes|no>` unvotes then casts through the real
  `castVote` with the tab staying on My Votes.
- Impact preview panel on the proposal detail: `normalizeProposal`
  passes through an optional `impact` record (from
  `impact`/`impact_preview`/`impactPreview` spellings) normalised to
  `{ apps, appsCount, members, targetRelease, checks, summary }`, with
  `checks` entries as `{ name, state: 'passed'|'failed'|null }`. The
  panel renders on every detail view; anything the record lacks (or no
  record at all) shows an "Unknown" label, and merged proposals keep
  the panel as a read-only record. On small screens the body collapses
  behind a "Show details" toggle. Demo impact fixtures (`DEMO_IMPACT`
  in `server.js`, stamped through `normalizeImpact`) cover a full
  record with mixed pass/fail checks (demo-4), a full record (demo-2),
  the merged record (demo-5) and a partial record (demo-6, unknown
  labels). Demo hooks (staging + `?demo=1` only):
  `?impact-mobile=1` forces the collapsed small-screen presentation at
  any viewport, and `?tap-impact-toggle=1` taps the open detail's
  toggle after render (the real click path). Expansion state is per
  proposal in frontend memory only.
- Proposal detail screen: the Discuss button on a card opens it
  (existing `?proposal=<sessionId>` deep link also lands there). It shows
  a full untruncated description (`data-proposal-description`; empty
  summary falls back to the title with `data-description-fallback="1"`),
  a vote progress ring (yes/no counts, "N votes needed", and the
  "x of y yes to merge" label when the platform supplies a required
  count), a numbered timeline (opened, one row per yes voter with name,
  avatar and relative date, threshold-reached when met, merged with its
  date — voters' `votedAt` times pass through `normalizeProposal` from
  `voted_at`/`votedAt` spellings), the author handle and app name, a
  Related strip of other still-open proposals from the same app (hidden
  when none), and a sticky bottom action bar (Yes/No/Share) with a voted
  pill and disabled buttons once voted. Back restores the inbox's
  previous scroll position. Demo hooks (staging + `?demo=1` only):
  `?tap-card=1` clicks the demo-2 card's title after render; `?tap-back=1`
  scrolls the inbox to y=400, opens the demo-2 detail and clicks Back
  (the restored scroll is stamped on `body[data-inbox-scroll]`);
  `?scroll-detail=1` verifies the action bar stays within the viewport at
  scroll 0 and at the bottom of the detail, then stamps
  `[data-detail-actions][data-sticky-observed="1"]` (the flag survives
  re-renders, so the marker is re-emitted from the render function).
  Share reuses the existing share modes (`?share=sheet` keeps
  `data-share-mode="sheet"` on the detail's button).
- The app filter dropdown shows each app's open count (loaded proposals
  not yet merged) plus its merged-this-week count (merged within the
  last seven calendar days), both tallied from the already-loaded inbox
  data and re-tallied whenever the inbox reloads while the dropdown is
  open. No extra platform calls.
- App filter merge stats: each app row (not "All apps") carries three
  fixed-height lines so row size never depends on the values — the name
  with a four-bar weekly merge sparkline beside it (oldest first, this
  week on the right so the last bar equals merged-this-week; zero weeks
  are thin stubs; no merges in 28 days shows `data-app-spark="none"` and
  a dash), "N waiting · N merged this week" (waiting = not merged and not
  closed; `data-app-count` stays on the waiting span, so the old
  `(N)`-text checks now read "N waiting"), and "Median to merge (30
  days): X" — the median opened→merged time over merges in the trailing
  30 calendar days ("2d" from one day up, "5h" under a day, "<1h" under
  an hour; a merge with no open time or merging before opening counts in
  merged/spark but not the median). No merges in 30 days shows a dash
  (`data-app-median="none"`). All from `filterStats()` over the loaded
  inbox, recomputed on every load; while a forced refresh loads, the
  open dropdown holds the last good apps with grey `animate-pulse`
  placeholders (`data-stats-loading="1"` on the panel, via
  `lastFilterApps` — an empty `lastFilterApps` before the first load
  shows only the All apps row, as before). Demo hooks (staging +
  `?demo=1` only): `?mergestats=1` serves four merged staging-demo-app
  fixtures (opened/merged day anchors, durations 1d/2d/4d and a 40-days
  -back merge outside the window) plus demo-5 pinned to a whole 7d
  median, so the median/spark values are deterministic; the variant's
  expected values are app: 3 waiting / 1 this week / 2d (n=3) /
  spark 1,0,1,1, notes: 2 / 1 / 7d (n=1) / 0,0,0,1, archive: all dashes;
  `?tap-app-option=<slug>` taps that row through the real handler then
  reloads with `clear-set-filter=1` (the tap-tag pattern);
  `?stats-layout=1` refreshes through loadInbox with a one-shot
  `inboxHoldMs` fetch hold, requires the placeholders mid-hold and stamps
  `data-layout-stable="1"` when row heights and the list height agree
  before/during/after; `?filter-phone=1` pins the open panel to 288px and
  stamps `data-phone-fit` after checking every row's stat lines for
  overflow. `reanchorDemo` also honours `demoMergedAnchor { days }`
  (stamps mergedAt to local noon N days back).
- `?splits=<sessionId>:<yes>-<no>,…` (demo only) overrides named fixture
  proposals' vote counts so the controversy sort's tie behaviour is
  reachable by checks without changing the default fixture's numbers.
- The Controversy sort (closest yes/no split first; unanimous or one-sided
  proposals sink; equal gaps break by title) ranks the whole loaded inbox,
  so it renders one flat list — the age-group headers only apply to the
  default and Newest sorts, where the day buckets are the point.
- Keep the inbox fetch bounded: parallel with concurrency limit 8 and a
  10 s overall budget, plus short TTL caches (apps 60 s, promoted 30 s).
