# Vote Inbox

One inbox for all open proposals across Homeroom apps. See what's up for
a vote, how the counts stand, and cast your vote with one tap.

## How it works

- **Inbox** — the server asks the platform for the list of apps and each
  app's open (promoted) proposals (`GET /api/apps/:slug/promoted`),
  normalises them into one list sorted by votes still needed, and keeps a
  short-lived cache so refreshes are fast. Proposals are fetched in
  parallel with a bounded budget, so one slow app can't stall the page.
- **Voting** — the Yes/No buttons call `POST /api/sessions/:id/vote` on
  the platform, authenticated as the signed-in user (the app forwards the
  user's own platform token; it never holds credentials of its own). The
  UI updates optimistically and rolls back with an explanatory toast if
  the platform rejects the vote (already voted, expired, and so on).
- **My Votes** — every vote cast through this app is recorded in the
  app's own `my_votes` table (the platform exposes no cross-app "my
  votes" feed to apps). The tab shows the history with each proposal's
  outcome, refreshed against the platform's open-proposal lists: still
  listed means still voting; dropped means the vote ended.
- **Staging** — staging containers may lack a platform credential, so
  `?demo=1` serves obviously-fake fixture data ("Staging demo …") to keep
  the screens reviewable and checks deterministic. It never serves in
  production.

`my_votes` is marked `staging:private`: it is one person's vote history,
which strangers opening a staging preview should not see. Staging seeds
only fake-identity rows.

## Development

- `npm ci --include=dev && npm run build` compiles the Tailwind
  stylesheet to `public/tailwind.css` (the Docker build does this too).
- `npm start` runs the server on port 3000.

The app runs on Homeroom; see `CLAUDE.md` for app-specific notes and the
platform conventions it follows.