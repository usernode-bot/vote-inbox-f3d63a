const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what
// breaks every app at once when the platform's domain moves. Unset only
// outside the platform (a plain local `node server.js`).
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

// Version-pinned app-facing platform API (in-network). Used only as the
// fallback app-directory source when the platform's own app listing is
// unavailable to this app.
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL
  || process.env.USERNODE_PLATFORM_API_URL || '';

// The app credential for token-gated platform routes. Present in production,
// absent in staging — every use is guarded so staging degrades instead of
// calling with an empty token.
const APP_TOKEN = process.env.USERNODE_LLM_PROXY_TOKEN || '';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// How long the app waits on a single platform call, and the overall budget
// for one inbox aggregation pass. Cached loads return in microseconds; a
// cold load with a slow platform is bounded by the budget, not by the
// number of apps.
const FETCH_TIMEOUT_MS = 5000;
const INBOX_BUDGET_MS = 10000;
const PROMOTED_CONCURRENCY = 8;

app.use(express.json());

// "Now" for time-dependent answers (the members directory's active-this-week
// window). A staging preview opened at a chosen moment carries the platform's
// x-usernode-now header or un-now query; production always reads the clock,
// so the code path is identical everywhere and only the value differs.
const PREVIEW_NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
app.use((req, _res, next) => {
  const raw = IS_STAGING
    ? (req.headers['x-usernode-now'] || req.query['un-now'])
    : null;
  req.now = typeof raw === 'string' && PREVIEW_NOW_RE.test(raw)
    ? new Date(raw) : new Date();
  next();
});

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Platform proxying
//
// Open proposals live on the platform, not in this app's database. The two
// endpoints used here are the platform's own: GET /api/apps/:slug/promoted
// for an app's open (promoted) proposals and POST /api/sessions/:id/vote to
// cast a vote. Both authenticate with the caller's own platform identity,
// forwarded as a Bearer token — the same iframe JWT this app just verified,
// so a request is always made AS the signed-in user and can never exceed
// their access.
// ---------------------------------------------------------------------------

const userTokenFrom = (req) => req.headers['x-usernode-token'] || '';

async function platformFetch(pathname, { method = 'GET', body, userToken, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const headers = { accept: 'application/json' };
  if (userToken) headers.authorization = 'Bearer ' + userToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(PLATFORM_ORIGIN + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Tiny TTL cache. Proposal votes change on human timescales; a short cache
// keeps a fast refresh path and spares the platform a burst of fetches when
// several apps are polled at once.
const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Run async work over a list with bounded concurrency and an overall
// deadline. Entries not reached before the deadline come back rejected, so
// a cold inbox load is bounded in time no matter how many apps exist.
async function mapLimited(items, limit, fn, deadlineMs) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length && Date.now() < deadlineMs) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx)
        .then((value) => ({ status: 'fulfilled', value }),
              (error) => ({ status: 'rejected', reason: error }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  for (let i = 0; i < items.length; i++) {
    if (!out[i]) out[i] = { status: 'rejected', reason: new Error('deadline') };
  }
  return out;
}

// The list of Homeroom apps. Preferred source is the platform's own app
// listing (scoped to the signed-in user); the documented app-facing
// directory is the fallback where that fails and this app holds a token.
async function loadApps(userToken) {
  return cached('apps', 60_000, async () => {
    if (PLATFORM_ORIGIN) {
      try {
        const r = await platformFetch('/api/apps', { userToken });
        if (r.ok && r.data) {
          const list = Array.isArray(r.data) ? r.data
            : Array.isArray(r.data.apps) ? r.data.apps : null;
          if (list) {
            return list
              .map((a) => ({
                slug: a && a.slug,
                name: (a && a.name) || (a && a.slug),
                // Optional display icon; absent on apps that have none.
                icon: a && typeof a.icon_emoji === 'string' && a.icon_emoji ? a.icon_emoji : null,
              }))
              .filter((a) => a.slug);
          }
        }
      } catch {}
    }
    if (APP_TOKEN && PLATFORM_API_BASE) {
      try {
        const res = await fetch(PLATFORM_API_BASE + '/apps?include_wallets=0', {
          headers: { 'x-usernode-app-token': APP_TOKEN },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          const { apps } = await res.json();
          return (apps || [])
            .map((a) => ({
              slug: a.slug,
              name: a.name || a.slug,
              icon: typeof a.icon_emoji === 'string' && a.icon_emoji ? a.icon_emoji : null,
            }))
            .filter((a) => a.slug);
        }
      } catch {}
    }
    return null;
  });
}

// Canonical platform URL for one proposal, used by the cards' Copy link
// button. Null when there is nothing to link to: no platform origin at
// runtime, or the platform response carried no proposal id.
function proposalUrl(appSlug, proposalId) {
  if (!PLATFORM_ORIGIN || !appSlug || proposalId == null) return null;
  return PLATFORM_ORIGIN + '/app/' + encodeURIComponent(appSlug)
    + '/dev/proposals/' + encodeURIComponent(proposalId);
}

// Promoted (open, up-for-vote) proposals for one app. The platform's field
// spellings are normalised here so the frontend deals with one shape.
// Most votes-needed first; unknown requirement last, then fewest yes.
// Shared by the production inbox and the staging demo payload so the demo
// list's default order mirrors the real one.
function neededFirst(a, b) {
  const an = a.needed == null ? -1 : a.needed;
  const bn = b.needed == null ? -1 : b.needed;
  if (an !== bn) return bn - an;
  if (a.yes !== b.yes) return a.yes - b.yes;
  return a.title.localeCompare(b.title);
}

// The fixed tag list a proposal can carry. Tags arrive (when a response has
// them at all) under the usual spellings as an array of names or one
// comma-separated string; anything outside this list is dropped, so the
// cards' chips and the header tag filter always agree on what exists.
const TAG_LIST = ['bug', 'feature', 'copy', 'ux'];

// The proposal's impact preview, when the platform sends one: an optional
// object under any of the usual spellings, normalised to one shape for the
// detail screen's impact panel. Every field is optional and independent —
// the panel labels whatever is missing "Unknown" rather than guessing.
// Values are capped (same reasoning as the 50-voter cap) so a large
// payload cannot bloat the inbox response. Returns null when the response
// carries nothing usable, so the panel renders an all-Unknown record.
function normalizeImpact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 4000) : null);
  // Apps touched: an array of names, or a bare count when the platform
  // sends a number instead of the list.
  const rawApps = [raw.apps, raw.apps_affected, raw.appsAffected, raw.apps_touched, raw.appsTouched]
    .find((v) => Array.isArray(v) || (Number.isInteger(v) && v >= 0));
  let apps = null;
  let appsCount = null;
  if (Array.isArray(rawApps)) {
    apps = rawApps.map((n) => (typeof n === 'string' ? n.trim() : ''))
      .filter(Boolean).slice(0, 20);
    if (!apps.length) apps = null;
  } else if (typeof rawApps === 'number') {
    appsCount = rawApps;
  }
  const members = [raw.members, raw.members_affected, raw.membersAffected,
    raw.members_touched, raw.membersTouched]
    .find((v) => Number.isInteger(v) && v >= 0) ?? null;
  const targetRelease = str(raw.target_release) ?? str(raw.targetRelease)
    ?? str(raw.release) ?? str(raw.target);
  // Automated checks: entries are either plain name strings or objects
  // carrying a name plus a result. A result that is neither passed nor
  // failed (or absent) normalises to state null — the panel then shows the
  // row without a tick rather than a wrong verdict.
  const rawChecks = [raw.checks, raw.automated_checks, raw.automatedChecks,
    raw.check_list, raw.checkList]
    .find(Array.isArray) || null;
  const checks = rawChecks === null ? null : rawChecks.slice(0, 30)
    .map((c) => {
      if (typeof c === 'string' && c.trim()) return { name: c.trim(), state: null };
      if (!c || typeof c !== 'object') return null;
      const name = [c.name, c.title, c.label]
        .find((v) => typeof v === 'string' && v.trim());
      if (!name) return null;
      const passed = c.passed === true || c.ok === true
        || c.state === 'passed' || c.status === 'passed';
      const failed = c.passed === false || c.ok === false
        || c.state === 'failed' || c.status === 'failed';
      return { name: name.trim().slice(0, 200), state: passed ? 'passed' : failed ? 'failed' : null };
    })
    .filter(Boolean);
  const summary = str(raw.plain_summary) ?? str(raw.plainSummary)
    ?? str(raw.what_changes) ?? str(raw.whatChanges)
    ?? str(raw.user_summary) ?? str(raw.userSummary)
    ?? str(raw.summary);
  if (apps === null && appsCount === null && members === null
      && targetRelease === null && checks === null && summary === null) {
    return null;
  }
  return { apps, appsCount, members, targetRelease, checks, summary };
}

function normalizeProposal(raw, appItem) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = raw.session_id ?? raw.sessionId
    ?? (raw.session && raw.session.id) ?? raw.id;
  if (sessionId === undefined || sessionId === null) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const proposalId = raw.proposal_id != null ? String(raw.proposal_id)
    : raw.pr_number != null ? String(raw.pr_number) : null;
  const yes = num(raw.votes_for) ?? num(raw.votesFor) ?? num(raw.yes_votes) ?? 0;
  const no = num(raw.votes_against) ?? num(raw.votesAgainst) ?? num(raw.no_votes) ?? 0;
  const required = num(raw.votes_required) ?? num(raw.votesRequired) ?? num(raw.required);
  const title = (typeof raw.title === 'string' && raw.title.trim())
    || (typeof raw.name === 'string' && raw.name.trim())
    || 'Untitled proposal';
  // When the proposal was made, for the relative-age label on cards.
  const proposedAt = [raw.proposed_at, raw.proposedAt, raw.created_at, raw.createdAt]
    .find((v) => typeof v === 'string' && v) || null;
  // When the proposal merged, for the merged date on My Votes rows.
  const mergedAt = [raw.merged_at, raw.mergedAt]
    .find((v) => typeof v === 'string' && v) || null;
  // The proposal's yes voters, when the platform response names them: an
  // optional field under any of the usual spellings, entries either plain
  // username strings or objects carrying a username. Normalised to
  // { username, name, votedAt } for the cards' avatar row and the detail
  // screen's timeline (votedAt is the optional per-vote timestamp, '' when
  // the response carries none); null when the response carries no usable
  // list (the row simply does not render then). Capped to keep a
  // pathological payload from bloating the inbox response.
  const rawVoters = [raw.yes_voters, raw.yesVoters, raw.voters_for, raw.votersFor]
    .find(Array.isArray) || null;
  const yesVoters = rawVoters === null ? null : rawVoters
    .map((v) => {
      if (typeof v === 'string') return { username: v.trim(), name: '', votedAt: '' };
      if (v && typeof v === 'object' && typeof v.username === 'string') {
        const name = typeof v.name === 'string' ? v.name.trim() : '';
        const votedAt = [v.voted_at, v.votedAt]
          .find((t) => typeof t === 'string' && t) || '';
        return { username: v.username.trim(), name, votedAt };
      }
      return null;
    })
    .filter((v) => v && v.username)
    .slice(0, 50);
  // The change summary, when the platform sends one: an optional field under
  // any of the usual spellings, trimmed and capped so a large payload cannot
  // bloat the inbox response (the same reasoning as the 50-voter cap). Null
  // when the response carries none, so the card's summary row simply does
  // not render.
  const rawSummary = [raw.summary_md, raw.summaryMd, raw.summary, raw.description]
    .find((v) => typeof v === 'string' && v.trim()) || null;
  const summary = rawSummary === null ? null : rawSummary.trim().slice(0, 4000);
  // How many files the change touches, when the response says so: either a
  // non-negative integer, used as is, or an array of file names (its length
  // — some responses list the files instead of counting them). Negative,
  // fractional, string and non-finite values count as missing, so the card
  // shows no number rather than a wrong one.
  const rawFiles = [raw.files_changed, raw.filesChanged, raw.changed_files, raw.changedFiles]
    .find((v) => (Number.isInteger(v) && v >= 0) || Array.isArray(v));
  const filesChanged = rawFiles === undefined ? null
    : Array.isArray(rawFiles) ? rawFiles.length : rawFiles;
  // The proposal's tags, when the response carries any: an array of names or
  // one comma-separated string, under the usual spellings. Normalised to
  // lowercase fixed-list names, deduped in first-seen order; unknown names
  // are dropped so the cards' chips and the header tag filter always agree
  // on what exists. The full kept list stays on the proposal (the filter
  // counts and the tag filter ask "carries this tag" over all of it); the
  // card itself renders at most two chips. An empty array means the response
  // carried no usable tag and the card renders no chip row.
  const rawTags = [raw.tags, raw.labels]
    .find((v) => Array.isArray(v) || typeof v === 'string') || null;
  const tags = [];
  if (rawTags !== null) {
    const names = Array.isArray(rawTags) ? rawTags : String(rawTags).split(',');
    const seenTags = new Set();
    for (const t of names) {
      if (typeof t !== 'string') continue;
      const name = t.trim().toLowerCase();
      if (!name || seenTags.has(name) || !TAG_LIST.includes(name)) continue;
      seenTags.add(name);
      tags.push(name);
    }
  }
  // The impact preview for the detail screen's panel: null when the
  // platform sent none, so the panel labels every field Unknown.
  const impact = normalizeImpact(raw.impact ?? raw.impact_preview ?? raw.impactPreview);
  return {
    sessionId: String(sessionId),
    proposalId,
    url: proposalUrl(appItem.slug, proposalId),
    title,
    author: typeof raw.author === 'string' ? raw.author
      : typeof raw.username === 'string' ? raw.username : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    eta: typeof raw.eta === 'string' ? raw.eta : null,
    proposedAt,
    mergedAt,
    appSlug: appItem.slug,
    appName: appItem.name,
    yes,
    no,
    required,
    yesVoters,
    summary,
    filesChanged,
    tags,
    impact,
    needed: required != null ? Math.max(0, required - yes) : null,
  };
}

async function loadPromoted(slug, userToken) {
  return cached('promoted:' + slug, 30_000, async () => {
    const r = await platformFetch(
      '/api/apps/' + encodeURIComponent(slug) + '/promoted', { userToken });
    if (!r.ok) throw new Error('promoted ' + r.status);
    const items = Array.isArray(r.data) ? r.data
      : r.data && Array.isArray(r.data.proposals) ? r.data.proposals
      : r.data && Array.isArray(r.data.items) ? r.data.items : null;
    if (!items) throw new Error('unexpected promoted response shape');
    return items.map((i) => normalizeProposal(i, { slug, name: slug })).filter(Boolean);
  });
}

// ---------------------------------------------------------------------------
// Merge queue positions
//
// An approved proposal (status 'merging') goes live through its APP's own
// merge pipeline, so its queue is per app: the platform's `eta` is the
// earliest time that proposal can auto-merge, and eta order is the order
// the pipeline will reach the app's waiting proposals. The position is
// stamped server-side so every client and check sees the same number,
// 1 = next to merge. Proposals still voting or already merged get no
// position at all, so the card badge disappears on merge: there is nothing
// left to wait for.
// ---------------------------------------------------------------------------

function stampQueuePositions(proposals) {
  const byApp = new Map();
  for (const p of proposals) {
    if (p.status !== 'merging') continue;
    let queue = byApp.get(p.appSlug);
    if (!queue) byApp.set(p.appSlug, (queue = []));
    queue.push(p);
  }
  for (const queue of byApp.values()) {
    queue.sort((a, b) => {
      const ta = a.eta ? Date.parse(a.eta) : NaN;
      const tb = b.eta ? Date.parse(b.eta) : NaN;
      if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb;
      // A proposal the platform sent no countdown for queues behind the
      // known ones; between two unknowns the loaded order stands (stable).
      if (!isNaN(ta)) return -1;
      if (!isNaN(tb)) return 1;
      return 0;
    });
    queue.forEach((p, i) => { p.queuePos = i + 1; });
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Votes this user cast through this app.
//
// The platform does not expose a cross-app "my votes" feed to apps, so the
// inbox records each vote the user casts here. One small table, marked
// staging:private: it is one person's vote history, which is exactly the
// "would a stranger seeing every row be a problem?" case. No foreign keys,
// and staging seeds only fake-identity rows.
// ---------------------------------------------------------------------------

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS my_votes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      app_slug VARCHAR(255) NOT NULL,
      app_name VARCHAR(255) NOT NULL DEFAULT '',
      session_id VARCHAR(128) NOT NULL,
      proposal_id VARCHAR(128),
      title TEXT NOT NULL,
      choice VARCHAR(4) NOT NULL CHECK (choice IN ('yes', 'no')),
      status VARCHAR(16) NOT NULL DEFAULT 'voting',
      votes_for INTEGER NOT NULL DEFAULT 0,
      votes_against INTEGER NOT NULL DEFAULT 0,
      votes_required INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, session_id)
    );
    COMMENT ON TABLE my_votes IS 'staging:private';
    -- The starter template's demo table; the real app does not use it.
    DROP TABLE IF EXISTS presses;
  `);
  // Discussion threads on proposals: comments are in-app content every
  // member sees on a proposal's detail screen, so the table stays public
  // (no staging:private marker). It carries no foreign key to a private
  // table; its only relation is to itself (a reply's parent comment).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposal_comments (
      id SERIAL PRIMARY KEY,
      app_slug VARCHAR(255) NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      parent_id INTEGER REFERENCES proposal_comments(id),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS proposal_comments_thread_idx
      ON proposal_comments (app_slug, session_id, id);
  `);
  await pool.query(
    'ALTER TABLE my_votes ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ');
  // The user's starred proposals and the status each row was last seen in.
  // Like my_votes this is one person's own data (what they watch), so it is
  // staging:private. No foreign keys; proposal content stays on the platform.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      app_slug VARCHAR(255) NOT NULL DEFAULT '',
      app_name VARCHAR(255) NOT NULL DEFAULT '',
      session_id VARCHAR(128) NOT NULL,
      proposal_id VARCHAR(128),
      title TEXT NOT NULL,
      last_seen_status VARCHAR(16),
      starred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, session_id)
    );
    COMMENT ON TABLE watchlist IS 'staging:private';
  `);
  // The user's saved inbox searches: a name, the search text and the filters
  // each chip holds, plus when it was last opened so the chip can count new
  // matches since. Like watchlist this is one person's own data, so it is
  // staging:private. The unique index keeps one name per person (case
  // ignored); a duplicate save is a server-side no-op.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      name VARCHAR(60) NOT NULL,
      query VARCHAR(200) NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS saved_searches_user_name_idx
      ON saved_searches (user_id, lower(name));
    COMMENT ON TABLE saved_searches IS 'staging:private';
  `);
  // Snoozed proposals: one person's "hide this from my inbox until <date>"
  // marks. Like my_votes and watchlist this is per-user tracking data, so it
  // is staging:private. No foreign keys; proposal content stays on the
  // platform. A row is the snooze itself: unsnoozing deletes it, and a row
  // whose wake time has passed is dropped on the next read, which is what
  // makes a snoozed proposal reappear automatically.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snoozes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      app_slug VARCHAR(255) NOT NULL DEFAULT '',
      app_name VARCHAR(255) NOT NULL DEFAULT '',
      session_id VARCHAR(128) NOT NULL,
      proposal_id VARCHAR(128),
      title TEXT NOT NULL,
      wake_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, session_id)
    );
    COMMENT ON TABLE snoozes IS 'staging:private';
  `);
  // Merge celebrations: one row per (user, proposal) the app should
  // celebrate having merged. Like my_votes and snoozes this is one
  // person's own tracking data, so it is staging:private, and it carries
  // only what the card renders (title, app, the caller's choice) — the
  // proposal itself stays on the platform. `shown` is set once the card
  // has rendered (a celebration is a one-time card per proposal);
  // `dismissed` is set when the user dismisses it. Both persist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merge_celebrations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      app_slug VARCHAR(255) NOT NULL DEFAULT '',
      app_name VARCHAR(255) NOT NULL DEFAULT '',
      session_id VARCHAR(128) NOT NULL,
      proposal_id VARCHAR(128),
      title TEXT NOT NULL,
      choice VARCHAR(4) NOT NULL DEFAULT 'yes',
      merged_at TIMESTAMPTZ,
      shown BOOLEAN NOT NULL DEFAULT FALSE,
      dismissed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, session_id)
    );
    COMMENT ON TABLE merge_celebrations IS 'staging:private';
  `);
}

async function seedStaging() {
  // Fake identity only — never rows owned by whoever opens the preview.
  await pool.query(`
    INSERT INTO my_votes
      (user_id, username, app_slug, app_name, session_id, proposal_id, title, choice, status, votes_for, votes_against, votes_required, merged_at)
    VALUES
      (900001, 'staging-demo-user', 'staging-demo-app', 'Staging Demo App', 'demo-seed-1', NULL,
       'Staging demo proposal: weekly summary email', 'yes', 'voting', 3, 1, 5, NULL),
      (900001, 'staging-demo-user', 'staging-demo-app', 'Staging Demo App', 'demo-seed-2', NULL,
       'Staging demo proposal: custom themes', 'no', 'merged', 6, 0, 5, NOW() - INTERVAL '2 days'),
      (900001, 'staging-demo-user', 'staging-demo-notes', 'Staging Demo Notes', 'demo-seed-3', NULL,
       'Staging demo proposal: pinned notes', 'yes', 'closed', 4, 2, 5, NULL)
    ON CONFLICT (user_id, session_id) DO NOTHING
  `);
}

async function recordVote(v) {
  await pool.query(`
    INSERT INTO my_votes
      (user_id, username, app_slug, app_name, session_id, proposal_id, title, choice, status, votes_for, votes_against, votes_required)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'voting', $9, $10, $11)
    ON CONFLICT (user_id, session_id) DO UPDATE
      SET choice = EXCLUDED.choice,
          title = EXCLUDED.title,
          app_name = EXCLUDED.app_name,
          proposal_id = EXCLUDED.proposal_id,
          updated_at = NOW()
  `, [v.userId, v.username, v.appSlug, v.appName, v.sessionId, v.proposalId,
      v.title, v.choice, v.yes, v.no, v.required]);
}

async function myVotesMap(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT session_id, choice FROM my_votes WHERE user_id = $1', [userId]);
    return new Map(rows.map((r) => [r.session_id, r.choice]));
  } catch {
    return new Map();
  }
}

// Stamp each proposal with the caller's own recorded vote, if any. A real
// record always wins; a myVote already on the proposal survives only as a
// fallback (the demo fixture marks some proposals voted — production
// proposals never carry the field, so this changes nothing there).
async function withMyVotes(proposals, userId) {
  const mine = await myVotesMap(userId);
  for (const p of proposals) p.myVote = mine.get(p.sessionId) || p.myVote || null;
  return proposals;
}

// ---------------------------------------------------------------------------
// Watchlist: proposals the user starred, with the status each row was last
// seen in. Rows are per user (staging:private — it is one person's tracking
// data). The proposal content itself stays on the platform; the row keeps
// just enough to render the tab and to re-find the proposal's app.
// ---------------------------------------------------------------------------

// The session ids this user has starred, for stamping the inbox cards.
async function watchSetFor(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT session_id FROM watchlist WHERE user_id = $1', [userId]);
    return new Set(rows.map((r) => r.session_id));
  } catch {
    return new Set();
  }
}

// Stamp each proposal with the caller's own star. Real rows always win;
// ?preset-star=<sessionId,...> (demo checks) marks extra ones starred for
// that one load without touching storage.
async function withMyStars(proposals, userId, req) {
  const mine = await watchSetFor(userId);
  const preset = req && req.query['preset-star']
    ? String(req.query['preset-star']).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const p of proposals) {
    p.myStar = mine.has(p.sessionId) || preset.includes(p.sessionId) || p.myStar === true;
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Snoozes: proposals the user tucked away until a wake date. Rows are per
// user (staging:private, same reasoning as watchlist). Snoozing is purely a
// view concern: it never touches votes or the platform's merge state, so the
// row keeps only enough to render the Snoozed filter and re-find the app.
// ---------------------------------------------------------------------------

// The caller's active snoozes, session id -> wake time. A wake time that has
// already passed no longer holds the proposal, so those rows are deleted on
// read: the next inbox load simply lists the proposal again, which is the
// "reappears automatically after the wake date" rule — no sweeper needed.
async function snoozeMapFor(userId) {
  try {
    await pool.query(
      'DELETE FROM snoozes WHERE user_id = $1 AND wake_at <= NOW()', [userId]);
    const { rows } = await pool.query(
      'SELECT session_id, wake_at FROM snoozes WHERE user_id = $1', [userId]);
    const map = new Map();
    for (const r of rows) map.set(r.session_id, r.wake_at);
    return map;
  } catch {
    return new Map();
  }
}

// Stamp each proposal with the caller's own snooze wake time (ISO string)
// when one is still ahead. Expired rows were already dropped by the read.
async function withMySnoozes(proposals, userId) {
  const mine = await snoozeMapFor(userId);
  for (const p of proposals) {
    const wake = mine.get(p.sessionId);
    p.mySnooze = wake ? new Date(wake).toISOString() : null;
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Merge celebrations. When a proposal the caller voted on (through this app)
// is now reported merged, a one-time celebration card shows at the top of
// their inbox: the title, the app, and "you voted yes". Detection happens
// wherever the caller's recorded votes meet the merge state (the inbox load,
// and the demo fixtures behind ?celeb=1); `merged` must be recent, since a
// merge first seen weeks later is history, not news. One row per (user,
// proposal), created only once in production — the `reset` demo mode re-arms
// the caller's rows so every check run starts from unseen cards.
// ---------------------------------------------------------------------------

const CELEBRATION_MERGE_WINDOW_MS = 7 * 24 * 3600 * 1000;

async function syncMergeCelebrations(proposals, user, opts) {
  const now = Date.now();
  for (const p of proposals) {
    if (!p.myVote || p.status !== 'merged' || !p.mergedAt) continue;
    const merged = Date.parse(p.mergedAt);
    if (!isFinite(merged) || now - merged > CELEBRATION_MERGE_WINDOW_MS) continue;
    const conflict = opts && opts.reset
      ? 'DO UPDATE SET shown = FALSE, dismissed = FALSE, choice = EXCLUDED.choice,'
        + ' merged_at = EXCLUDED.merged_at, title = EXCLUDED.title'
      : 'DO NOTHING';
    try {
      await pool.query(`
        INSERT INTO merge_celebrations
          (user_id, username, app_slug, app_name, session_id, proposal_id, title, choice, merged_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (user_id, session_id) ${conflict}
      `, [user.id, user.username, p.appSlug || '', p.appName || '', p.sessionId,
          p.proposalId || null, p.title, p.myVote, p.mergedAt]);
    } catch {
      // Celebration bookkeeping never blocks the inbox.
    }
  }
}

// The caller's pending celebrations: not yet shown and not dismissed,
// newest recorded first (so several merges stack newest on top).
async function pendingCelebrations(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT app_slug, app_name, session_id, proposal_id, title, choice, merged_at
       FROM merge_celebrations
       WHERE user_id = $1 AND shown = FALSE AND dismissed = FALSE
       ORDER BY id DESC`, [userId]);
    return rows.map((r) => ({
      sessionId: r.session_id,
      proposalId: r.proposal_id,
      appSlug: r.app_slug,
      appName: r.app_name || r.app_slug,
      title: r.title,
      choice: r.choice,
      mergedAt: r.merged_at,
    }));
  } catch {
    return [];
  }
}

// Status a row is on now, for the "since last look" badge. Current status
// comes from the app's promoted list when the platform answers for it:
// still listed means open ('voting', or the platform's own merging state),
// dropped from the list means the vote ended ('closed'). When the app's
// list cannot be loaded the last-seen status stands, so a platform outage
// never fabricates a change badge.
async function withCurrentStatuses(rows, userToken) {
  const byApp = new Map();
  for (const r of rows) {
    if (!byApp.has(r.app_slug)) byApp.set(r.app_slug, []);
    byApp.get(r.app_slug).push(r);
  }
  for (const [slug, list] of byApp) {
    let items = null;
    try { items = await loadPromoted(slug, userToken); } catch { items = null; }
    const bySession = items ? new Map(items.map((i) => [i.sessionId, i])) : null;
    for (const r of list) {
      if (bySession) {
        const item = bySession.get(r.session_id);
        r.current_status = item
          ? (item.status === 'merging' || item.status === 'merged' ? item.status : 'voting')
          : 'closed';
      } else {
        r.current_status = r.last_seen_status || 'voting';
      }
    }
  }
}

function watchRowPayload(r) {
  const changed = !!r.current_status
    && r.last_seen_status != null
    && r.current_status !== r.last_seen_status;
  return {
    sessionId: r.session_id,
    appSlug: r.app_slug,
    appName: r.app_name || r.app_slug,
    icon: r.icon || null,
    proposalId: r.proposal_id || null,
    title: r.title,
    starredAt: r.starred_at || null,
    seenStatus: r.last_seen_status,
    status: r.current_status || r.last_seen_status || 'voting',
    changed,
  };
}

// ---------------------------------------------------------------------------
// Staging demo data (?demo=1)
//
// The inbox and history screens render against real platform calls in
// production. Staging containers may not hold a working platform credential,
// so ?demo=1 serves obviously-fake fixture data (request-time injection,
// behind IS_STAGING) that keeps the screens reviewable and the declared
// checks deterministic. It is never served in production.
// ---------------------------------------------------------------------------

function demoInbox() {
  const apps = [
    { slug: 'staging-demo-app', name: 'Staging Demo App', icon: '📮' },
    { slug: 'staging-demo-notes', name: 'Staging Demo Notes', icon: '🗒️' },
    // A third app with no open proposals, so nothing else on the screen can
    // carry its name: the filter-persisted check's expectText only matches
    // when the restored filter names this app in the trigger, and a tester
    // landing on it sees the "Show all apps" empty state of a real filter.
    { slug: 'staging-demo-archive', name: 'Staging Demo Archive', icon: '🗄️' },
  ];
  // Fake yes-voter identities for the cards' avatar row and the detail
  // screen's timeline; "(demo)" in the display name keeps them obviously
  // made up, matching the seed rules. `agoMs` optionally stamps when the
  // vote was cast (ms ago), for the timeline's relative "2h ago" label;
  // ages are chosen mid-bucket (2.5h, 1.5d) so relTime's output never
  // changes across an hourly or daily bucket boundary, and are NOT
  // midnight-capped: a vote row's age crossing into yesterday only moves
  // "2h ago" to "3h ago" for a few hours, never breaks a check (checks read
  // demo-4's rows, whose ages stay inside today at any hour).
  const voter = (u, agoMs) => ({
    username: 'staging-demo-' + u.toLowerCase(),
    name: u + ' (demo)',
    votedAt: agoMs != null ? new Date(Date.now() - agoMs).toISOString() : '',
  });
  // `anchor` is a demo hint the frontend uses to re-place the fixture on the
  // viewer's own calendar (see reanchorDemo in public/index.html): days back
  // from today, and for day 0 how many hours ago, plus a floor in minutes
  // past local midnight so just-after-midnight runs cannot clamp two
  // fixtures onto the same instant. proposedAt stays the real elapsed-time
  // stamp for any consumer that does not re-anchor. `mergedAgeMs` stamps
  // when a merged proposal merged (ms ago), for the app filter's
  // merged-this-week count.
  const mk = (slug, sessionId, proposalId, title, yes, no, required, status, ageMs, myVote, voters, anchor, mergedAgeMs) => ({
    sessionId,
    proposalId,
    // Without a configured platform origin (a bare check worker, not real
    // staging) proposalUrl is null and the cards would lose their Copy link
    // button, so the fixture carries a reserved `.invalid` stand-in: same
    // shape, obviously fake, clipboard-harmless.
    url: proposalUrl(slug, proposalId)
      || 'https://staging-demo.invalid/app/' + encodeURIComponent(slug)
        + '/dev/proposals/' + encodeURIComponent(proposalId),
    title,
    author: 'staging-demo-user',
    status: status || null,
    eta: null,
    proposedAt: ageMs != null ? new Date(Date.now() - ageMs).toISOString() : null,
    mergedAt: mergedAgeMs != null ? new Date(Date.now() - mergedAgeMs).toISOString() : null,
    demoAnchor: anchor || null,
    appSlug: slug,
    appName: apps.find((a) => a.slug === slug).name,
    icon: apps.find((a) => a.slug === slug).icon,
    yes,
    no,
    required,
    yesVoters: voters || null,
    needed: required != null ? Math.max(0, required - yes) : null,
    myVote: myVote || null,
  });
  const H = 3600 * 1000;
  const D = 24 * H;
  // The two Today-group fixtures use relative ages (3h, 8h), which cross UTC
  // midnight every day: between 00:00 and 08:00 UTC a 3h-old timestamp lands
  // on yesterday, the Today group empties, and the age-groups check loses its
  // "Today" header. Capping the ages at ms-since-UTC-midnight (the epoch is a
  // UTC midnight, so Date.now() % D is that) keeps both timestamps inside the
  // current UTC day at any hour — the age just shrinks near midnight instead
  // of falling into yesterday. The Other fixtures (1d, 2d, 5d, 9d) are stable
  // across the boundary and keep their plain ages.
  const todayCap = () => Date.now() % D;
  // Two of the six are marked already voted so the Hide voted toggle has
  // something to filter in previews. Statuses cover the three card labels:
  // null (an open proposal, Voting), 'merging' and 'merged'. demo-5 is the
  // one merged proposal, and it merged 2.5 days ago (within the week, and
  // mid-bucket so the detail timeline's "2d ago" merged label never shifts)
  // so the app filter's merged-this-week count is nonzero for its app while
  // the other app reads 0. demo-4 carries
  // seven yes voters (with a threshold keeping its "+2" avatar chip) so the
  // avatar row shows its max-5-then-"+N" case in previews and checks, and a
  // deliberately long title (3+ rendered lines) so the expandable-title
  // More/Less control has something to clamp in every preview. With
  // required 11 it needs 4 more votes, the most in the list, so it must stay
  // the MOST votes-needed proposal: the default most-votes-needed-first order
  // puts it on top (neededFirst breaks ties by fewest yes, so a tie here
  // would not), and the default-order check expects it as the first card. The
  // header summary's "9 votes needed" depends on 4 + 3 + 1 + 1 across
  // demo-4/demo-2/demo-1/demo-6. demo-1 and demo-6 each sit exactly one yes
  // vote from their threshold so the One vote away chip has something to show.
  const proposals = [
    mk('staging-demo-app', 'demo-2', 90201, 'Staging demo proposal: weekly summary email', 1, 0, 4, null, Math.min(3 * H, todayCap()), null, [voter('Maya', 2.5 * H)], { days: 0, hoursAgo: 3, clampMin: 2 }, null),
    mk('staging-demo-notes', 'demo-4', 90202, 'Staging demo proposal: keyboard shortcuts everywhere, plus a deliberately very long title that wraps past the second line so the card shows its More control in previews and checks', 7, 2, 11, null, Math.min(8 * H, todayCap()), null,
      ['Maya', 'Omar', 'Priya', 'Quinn', 'Raul', 'Sara', 'Tom'].map((u, i) => voter(u, (7.5 - i) * H)), { days: 0, hoursAgo: 8, clampMin: 1 }, null),
    mk('staging-demo-app', 'demo-1', 90203, 'Staging demo proposal: add a dark mode toggle', 3, 1, 4, null, 2 * D, 'no', [voter('Omar', 1.75 * D), voter('Priya', 1.5 * D), voter('Quinn', 1.25 * D)], { days: 2 }, null),
    mk('staging-demo-notes', 'demo-6', 90206, 'Staging demo proposal: tag colours', 2, 0, 3, null, 1 * D, null, [voter('Maya', 0.9 * D), voter('Omar', 0.8 * D)], { days: 1 }, null),
    mk('staging-demo-app', 'demo-3', 90204, 'Staging demo proposal: export to CSV', 4, 0, 4, 'merging', 5 * D, 'yes', [voter('Maya', 4.5 * D), voter('Priya', 3.5 * D), voter('Raul', 2.5 * D), voter('Sara', 1.5 * D)], { days: 5 }, null),
    mk('staging-demo-notes', 'demo-5', 90205, 'Staging demo proposal: pinned notes', 2, 1, null, 'merged', 9 * D, null, [voter('Quinn', 7.5 * D), voter('Raul', 6.5 * D)], { days: 9 }, 2.5 * D),
  ];
  // Change summaries for the cards' one-line summary row (demo only). Keyed
  // by sessionId; every fixture not covered gets an explicit null pair so
  // the demo shape matches what normalizeProposal produces in production.
  // The text is obviously fake ("Staging demo summary: …"). Between them the
  // fixtures cover the clamped long summary (demo-4), a short one with the
  // singular count (demo-2), count accuracy (demo-3), summary with no count
  // (demo-1), count with no summary (demo-6) and neither (demo-5).
  const DEMO_CHANGE_SUMMARIES = {
    'demo-4': {
      summary: 'Staging demo summary: adds keyboard shortcuts for voting, moving between cards and opening the detail view. Shortcuts are listed in a help sheet opened with the question mark key, and every shortcut can be turned off in settings.',
      filesChanged: 12,
    },
    'demo-2': {
      summary: 'Staging demo summary: sends a weekly email listing open proposals.',
      filesChanged: 1,
    },
    'demo-3': {
      summary: 'Staging demo summary: adds an Export button that downloads the visible list as a CSV file.',
      filesChanged: 5,
    },
    'demo-1': {
      summary: 'Staging demo summary: adds a toggle that switches the app between light and dark looks.',
      filesChanged: null,
    },
    'demo-6': { summary: null, filesChanged: 3 },
    'demo-5': { summary: null, filesChanged: null },
  };
  // Tags for the cards' chip row and the header tag filter (demo only). The
  // fixtures cover: two tags (demo-2), three tags so the card's max-two
  // chip cap is observable (demo-4), a tag on a voted proposal so the tag
  // counts' hidden-proposal exclusion is observable (demo-1, voted no), a
  // single copy tag (demo-6), no tags at all (demo-3, so no chip row
  // renders), and a tag on the merged proposal so the counts' open-only
  // rule is observable (demo-5). The open, unvoted tallies therefore read
  // bug 2, feature 2, copy 1, ux 1.
  const DEMO_TAGS = {
    'demo-2': ['bug', 'feature'],
    'demo-4': ['bug', 'feature', 'ux'],
    'demo-1': ['bug'],
    'demo-6': ['copy'],
    'demo-3': [],
    'demo-5': ['ux'],
  };
  // Impact records for the detail screen's impact panel (demo only), raw
  // platform spellings, normalised on stamp. Text keeps the obviously fake
  // "Staging demo" prefix.
  const DEMO_IMPACT = {
    'demo-4': {
      apps_affected: ['Staging Demo Notes', 'Staging Demo Archive'],
      members_affected: 5,
      target_release: 'Staging demo build 2.4',
      automated_checks: [
        { name: 'Staging demo check: detail loads', status: 'passed' },
        { name: 'Staging demo check: thread replies', status: 'passed' },
        { name: 'Staging demo check: export runs', status: 'failed' },
      ],
      plain_summary: 'Staging demo impact: keyboard shortcuts land on every list screen at once, so the keys people already use keep working while the new panel keys arrive alongside them.',
    },
    'demo-2': {
      apps: ['Staging Demo App'],
      members: 3,
      targetRelease: 'Staging demo build 2.5',
      checks: [{ name: 'Staging demo check: inbox loads', passed: true }],
      summary: 'Staging demo impact: the weekly email goes out to the whole group the morning after this merges, and anyone can turn it off in settings from that day on.',
    },
    'demo-5': {
      apps_affected: ['Staging Demo Notes'],
      members_affected: 4,
      target_release: 'Staging demo build 2.3',
      automated_checks: [
        { name: 'Staging demo check: notes pin', status: 'passed' },
      ],
      plain_summary: 'Staging demo impact: pinned notes move to the top of every list, which is live for the whole group now that this has merged.',
    },
    'demo-6': {
      automated_checks: [
        { name: 'Staging demo check: tag colours', status: 'passed' },
      ],
    },
  };
  for (const p of proposals) {
    const s = DEMO_CHANGE_SUMMARIES[p.sessionId] || {};
    p.summary = s.summary != null ? s.summary : null;
    p.filesChanged = s.filesChanged != null ? s.filesChanged : null;
    p.tags = DEMO_TAGS[p.sessionId] || [];
    // Impact records for the detail screen's impact panel (demo only), in
    // the raw platform spellings and pushed through normalizeImpact so the
    // demo payload takes the same shape production produces. Coverage: full
    // record with a mixed pass/fail checks list (demo-4), a full record
    // (demo-2), the merged proposal's read-only record (demo-5), and a
    // partial record where apps/members/release/summary are missing so the
    // panel's Unknown labels are observable (demo-6). demo-1 and demo-3
    // carry none at all, like most production responses today.
    const imp = DEMO_IMPACT[p.sessionId];
    p.impact = imp ? normalizeImpact(imp) : null;
  }
  return { demo: true, apps, proposals, refreshedAt: new Date().toISOString() };
}

// The demo payload, optionally with every proposal marked voted
// (?allvoted=1) so the Hide voted toggle's empty state is reachable by the
// declared checks, or every proposal marked merged (?allmerged=1) for the
// Hide merged toggle the same way. Staging fixtures only. ?queue=1 turns
// the fixture into the merge-queue scenario below; positions are stamped
// last so every variant (and ?allmerged=1, which merges everything) leaves
// only genuinely queued proposals carrying a position.
function demoInboxPayload(req) {
  const demo = demoInbox();
  if (req.query.queue === '1') applyQueueScenario(demo.proposals, req);
  // Same ordering the production inbox uses, so the demo list's default
  // order mirrors the real one (and the sort checks are meaningful: the
  // fixture's authoring order happens to already be newest-first).
  demo.proposals.sort(neededFirst);
  if (req.query.allvoted === '1') {
    for (const p of demo.proposals) {
      if (!p.myVote) p.myVote = 'yes';
    }
  }
  if (req.query.allmerged === '1') {
    for (const p of demo.proposals) p.status = 'merged';
  }
  // Check-fixture variant (?turnoutalt=1, staging demo only): demo-3 and
  // demo-6 have merged since the first load, so the app filter's per-app
  // open and merged-this-week counts change and the page's refresh of those
  // numbers is observable (?turnout-refresh=1 drives that reload). Applied
  // before the allvoted/allmerged overrides; no declared check combines
  // them. demo-5's merge (2 days ago) is unchanged, so Notes gains one
  // merge and App gains its first.
  if (req.query.turnoutalt === '1') {
    for (const p of demo.proposals) {
      if (p.sessionId === 'demo-3') {
        p.status = 'merged';
        p.mergedAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      } else if (p.sessionId === 'demo-6') {
        p.status = 'merged';
        p.mergedAt = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      }
    }
  }
  stampQueuePositions(demo.proposals);
  // ?splits=<sessionId>:<yes>-<no>,… (demo only) overrides named proposals'
  // vote counts, so the controversy-sort checks can pin tie behaviour — two
  // proposals with the same gap — without changing the default fixture's
  // numbers. Values stay in the fixture's fake-identity style: counts only.
  const splits = String(req.query.splits || '');
  if (splits) {
    const bySession = new Map(demo.proposals.map((p) => [p.sessionId, p]));
    for (const part of splits.split(',')) {
      const m = /^([A-Za-z0-9_-]+):(\d+)-(\d+)$/.exec(part.trim());
      const p = m && bySession.get(m[1]);
      if (!p) continue;
      p.yes = Number(m[2]);
      p.no = Number(m[3]);
      p.needed = p.required != null ? Math.max(0, p.required - p.yes) : null;
    }
  }
  return demo;
}

// ?queue=1 (staging demo only) turns the fixture into a merge-queue
// scenario: four proposals approved and waiting to go live, all in ONE
// app's queue so the positions run 1st..4th on screen (positions are per
// app, mirroring the real pipeline, so demo-6 and demo-1 move onto
// staging-demo-app for the scenario). Each gets a staggered merge
// countdown, and the countdown order decides the positions. Variants the
// checks compose onto it: ?queue-eta=reverse hands out the countdowns in
// reverse, so position provably follows eta and not fixture order;
// ?no-eta=1 drops the countdowns entirely (fallback: the queue keeps the
// list's loaded order, unknown waits behind nothing); and
// ?merged=<session ids> marks proposals already through the pipeline, so
// a check URL can watch a badge disappear and the others renumber.
function applyQueueScenario(proposals, req) {
  const byId = new Map(proposals.map((p) => [p.sessionId, p]));
  const queuedIds = ['demo-3', 'demo-2', 'demo-6', 'demo-1'];
  for (const id of queuedIds) {
    const p = byId.get(id);
    if (!p) continue;
    p.appSlug = 'staging-demo-app';
    p.appName = 'Staging Demo App';
    p.icon = '📮';
  }
  const steps = [5, 12, 30, 55]; // minutes to merge, one per queued card
  const ids = req.query['queue-eta'] === 'reverse' ? [...queuedIds].reverse() : queuedIds;
  const noEta = req.query['no-eta'] === '1';
  ids.forEach((id, i) => {
    const p = byId.get(id);
    if (!p) return;
    p.status = 'merging';
    p.eta = noEta ? null
      : new Date(Date.now() + steps[i] * 60_000).toISOString();
  });
  const mergedIds = String(req.query.merged || '').split(',')
    .map((s) => s.trim()).filter(Boolean);
  for (const id of mergedIds) {
    const p = byId.get(id);
    if (!p) continue;
    p.status = 'merged';
    p.eta = null;
    p.mergedAt = new Date().toISOString();
  }
}

// Snooze check fixtures (staging demo only), applied to a demo inbox load
// before the caller's own snooze rows are stamped on:
//   ?snooze-past=<id>  records an already-expired snooze row for the caller
//                      on that fixture proposal, so the auto-reappear rule
//                      (an expired wake no longer holds the proposal) is
//                      observable by a check. The next read cleans the row
//                      up, exactly as it would for a real yesterday-snooze.
//   ?snooze-other=1    records an ACTIVE snooze on demo-3 for a fake member
//                      (staging-demo-user), so the per-user rule is
//                      observable: another member's snooze never hides a
//                      proposal from the caller.
// Both write only fake or check-fixture rows and only under ?demo=1.
async function applyDemoSnoozeFixtures(req) {
  const past = String(req.query['snooze-past'] || '').trim();
  if (past) {
    const p = demoInbox().proposals.find((x) => x.sessionId === past);
    if (p) {
      await pool.query(
        'DELETE FROM snoozes WHERE user_id = $1 AND session_id = $2',
        [req.user.id, past]);
      await pool.query(`
        INSERT INTO snoozes
          (user_id, username, app_slug, app_name, session_id, proposal_id, title, wake_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - INTERVAL '1 hour')`,
        [req.user.id, req.user.username, p.appSlug, p.appName, past, p.proposalId, p.title]);
    }
  }
  if (req.query['snooze-other'] === '1') {
    const p = demoInbox().proposals.find((x) => x.sessionId === 'demo-3');
    if (p) {
      await pool.query(`
        INSERT INTO snoozes
          (user_id, username, app_slug, app_name, session_id, proposal_id, title, wake_at)
        VALUES (900002, 'staging-demo-user', $1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
        ON CONFLICT (user_id, session_id) DO UPDATE SET wake_at = EXCLUDED.wake_at`,
        [p.appSlug, p.appName, p.sessionId, p.proposalId, p.title]);
    }
  }
}

// Celebration check fixtures (staging demo only), applied to a demo inbox
// load only when the load opts in with ?celeb=1 — the marker the celebration
// checks' pages and their reloaded marker pages carry, mirroring ?snooze=1 —
// so a plain ?demo=1 load never shows or creates celebration cards:
//   ?celebvote=<ids>  marks those fixture proposals as voted by the caller
//                     (the fixture's own choice stands; unvoted ones become
//                     yes) and merged, so the real detection path sees them;
//                     the caller's rows for them are re-armed too, so every
//                     check run starts from unseen cards no matter what an
//                     earlier run left behind.
//   ?celeb-clear=1    empties the caller's celebration rows first, so the
//                     "absent for proposals the caller did not vote on"
//                     check never sees leftovers from other checks.
async function applyDemoCelebrationFixtures(req, proposals) {
  if (req.query['celeb-clear'] === '1') {
    await pool.query('DELETE FROM merge_celebrations WHERE user_id = $1', [req.user.id]);
  }
  const ids = String(req.query.celebvote || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return;
  const byId = new Map(proposals.map((p) => [p.sessionId, p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    if (!p.myVote) p.myVote = 'yes';
    if (p.status !== 'merged') {
      p.status = 'merged';
      p.eta = null;
      delete p.queuePos;
      p.mergedAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    }
  }
}

// Shared tail of both demo inbox branches: the caller's stars, plus — behind
// the ?celeb=1 opt-in — the celebration fixtures, the real detection pass and
// the caller's pending celebration cards. Without the opt-in the payload
// stays celebration-free, the same determinism rule the snooze fixtures use.
async function finishDemoInbox(req, demo) {
  if (req.query.snooze === '1') await withMySnoozes(demo.proposals, req.user.id);
  await withMyStars(demo.proposals, req.user.id, req);
  demo.celebrations = [];
  if (req.query.celeb === '1') {
    await applyDemoCelebrationFixtures(req, demo.proposals);
    await syncMergeCelebrations(demo.proposals, req.user, { reset: true });
    demo.celebrations = await pendingCelebrations(req.user.id);
  }
  return demo;
}

function demoVoteRows() {
  const row = (sessionId, appSlug, appName, title, choice, status, yes, no,
               required, at, mergedAt) => ({
    id: 'demo-' + sessionId,
    app_slug: appSlug,
    app_name: appName,
    session_id: sessionId,
    title,
    choice,
    status,
    votes_for: yes,
    votes_against: no,
    votes_required: required,
    created_at: at,
    updated_at: at,
    merged_at: mergedAt || null,
  });
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 24 * 3600 * 1000).toISOString();
  return [
    row('demo-v1', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: weekly summary email', 'yes', 'voting', 3, 1, 5, daysAgo(1)),
    row('demo-v2', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: custom themes', 'no', 'merged', 6, 0, 5, daysAgo(4),
        daysAgo(2)),
    row('demo-v3', 'staging-demo-notes', 'Staging Demo Notes',
        'Staging demo proposal: pinned notes', 'yes', 'closed', 4, 2, 5, daysAgo(9)),
  ];
}

// ---------------------------------------------------------------------------
// Weekly-digest fixtures (?demo=1&digest=week|quiet), staging only. Rows
// carry a demo_anchor { weeksAgo, weekday } the frontend re-stamps to local
// noon of that weekday (see reanchorDigestDemo), so the digest's week
// buckets are deterministic relative to whenever the check runs. `week`
// gives 6 votes this week (2 of them merged), 4 last week (1 merged), 1
// two weeks ago and 1 four weeks ago: streak 3, "Up from 4 last week", and
// top apps App, Notes, Archive (Extras loses the alphabetical tie at the
// third slot). `quiet` gives nothing this week: streak 0 (the tile is left
// out), "Down from 2 last week", every bar zero, "None merged yet". Without
// ?digest= the default three demoVoteRows() are served, unchanged.
// ---------------------------------------------------------------------------

function demoDigestRows(kind) {
  const row = (id, sessionId, appSlug, appName, title, choice, status,
               yes, no, required, weeksAgo, weekday, merged) => ({
    id,
    app_slug: appSlug,
    app_name: appName,
    session_id: sessionId,
    title,
    choice,
    status,
    votes_for: yes,
    votes_against: no,
    votes_required: required,
    created_at: new Date(0).toISOString(), // re-stamped client-side
    updated_at: new Date(0).toISOString(),
    merged_at: merged ? new Date(0).toISOString() : null,
    demo_anchor: { weeksAgo, weekday },
  });
  if (kind === 'quiet') {
    return [
      row('dq-1', 'demo-q1', 'staging-demo-app', 'Staging Demo App',
          'Staging demo proposal: digest quiet export', 'no', 'closed', 2, 3, 5, 1, 1),
      row('dq-2', 'demo-q2', 'staging-demo-notes', 'Staging Demo Notes',
          'Staging demo proposal: digest quiet themes', 'yes', 'voting', 4, 1, 5, 1, 3),
      row('dq-3', 'demo-q3', 'staging-demo-archive', 'Staging Demo Archive',
          'Staging demo proposal: digest quiet search', 'yes', 'closed', 5, 0, 5, 3, 2),
    ];
  }
  return [
    // This week: 6 votes, 2 merged (one in App, one in Notes).
    row('dg-1', 'demo-w1', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: digest weekly recap', 'yes', 'voting', 3, 1, 5, 0, 0),
    row('dg-2', 'demo-w2', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: digest custom themes', 'yes', 'merged', 6, 0, 5, 0, 1, true),
    row('dg-3', 'demo-w3', 'staging-demo-notes', 'Staging Demo Notes',
        'Staging demo proposal: digest pinned notes', 'yes', 'voting', 4, 2, 5, 0, 1),
    row('dg-4', 'demo-w4', 'staging-demo-notes', 'Staging Demo Notes',
        'Staging demo proposal: digest export button', 'yes', 'merged', 6, 0, 5, 0, 2, true),
    row('dg-5', 'demo-w5', 'staging-demo-archive', 'Staging Demo Archive',
        'Staging demo proposal: digest archive search', 'no', 'voting', 2, 3, 5, 0, 2),
    row('dg-6', 'demo-w6', 'staging-demo-extras', 'Staging Demo Extras',
        'Staging demo proposal: digest quiet hours', 'yes', 'voting', 4, 1, 5, 0, 3),
    // Last week: 4 votes, 1 merged.
    row('dg-7', 'demo-w7', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: digest rate limits', 'yes', 'voting', 3, 2, 5, 1, 1),
    row('dg-8', 'demo-w8', 'staging-demo-notes', 'Staging Demo Notes',
        'Staging demo proposal: digest inline comments', 'yes', 'merged', 6, 1, 5, 1, 2, true),
    row('dg-9', 'demo-w9', 'staging-demo-archive', 'Staging Demo Archive',
        'Staging demo proposal: digest bulk move', 'no', 'closed', 2, 4, 5, 1, 3),
    row('dg-10', 'demo-w10', 'staging-demo-extras', 'Staging Demo Extras',
        'Staging demo proposal: digest dark mode', 'yes', 'voting', 5, 1, 5, 1, 4),
    // Two weeks ago: 1 vote. Three weeks ago: none, so the streak stops at 3.
    row('dg-11', 'demo-w11', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: digest keyboard nav', 'yes', 'closed', 5, 0, 5, 2, 2),
    // Four weeks ago: 1 vote.
    row('dg-12', 'demo-w12', 'staging-demo-notes', 'Staging Demo Notes',
        'Staging demo proposal: digest mobile layout', 'no', 'closed', 1, 4, 5, 4, 3),
  ];
}

// ---------------------------------------------------------------------------
// Watchlist demo data (?demo=1). Fixed fixture rows keyed to the demo inbox
// proposals, so the Watchlist tab and its "since last look" badges are
// deterministic in previews and checks. demo-5 (merged) and demo-3 (now
// merging) carry a last-seen status of 'voting', so both show a change
// badge; demo-1 is unchanged. Request-time injection, staging only.
// ---------------------------------------------------------------------------

function demoWatchRows() {
  const byId = new Map(demoInbox().proposals.map((p) => [p.sessionId, p]));
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  const mk = (sessionId, seenStatus, starredDays) => {
    const p = byId.get(sessionId);
    if (!p) return null;
    const status = p.status === 'proposed' ? 'voting' : (p.status || 'voting');
    return {
      sessionId,
      appSlug: p.appSlug,
      appName: p.appName,
      icon: p.icon || null,
      proposalId: p.proposalId,
      title: p.title,
      starredAt: daysAgo(starredDays),
      seenStatus,
      status,
      changed: seenStatus != null && status !== seenStatus,
    };
  };
  return [mk('demo-5', 'voting', 6), mk('demo-3', 'voting', 3), mk('demo-1', 'voting', 2)]
    .filter(Boolean);
}

// ?watch-seen=1 marks every fixture row as seen right now (no badges);
// ?watch-empty=1 serves no rows (the empty state). Both demo-only knobs so
// the declared checks can reach those states deterministically.
function demoWatchlistPayload(req) {
  const rows = demoWatchRows();
  if (req.query['watch-seen'] === '1') {
    for (const r of rows) {
      r.seenStatus = r.status;
      r.changed = false;
    }
  }
  if (req.query['watch-empty'] === '1') return { demo: true, rows: [] };
  return { demo: true, rows };
}

// ---------------------------------------------------------------------------
// Staging demo threads (?demo=1)
//
// A proposal detail's discussion reads real rows in production. Staging
// previews get obviously-fake fixture comments (fake identities, "Staging
// demo" wording, request-time injection behind IS_STAGING) plus anything
// posted during the preview itself — those live in server memory only,
// never the database, so a restart resets them and production never sees
// them. Fixture ids are negative so they can never collide with the
// database's SERIAL ids when a posted reply points at a fixture parent.
// ---------------------------------------------------------------------------

const demoCommentStore = new Map(); // '<appSlug>|<sessionId>' -> [rows]
let demoCommentSeq = -1000;

function demoCommentFixtures() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  return [
    { appSlug: 'staging-demo-notes', sessionId: 'demo-4', id: -100, parentId: null,
      username: 'staging-demo-maya',
      body: 'Staging demo comment: do the new shortcuts replace the current ones?',
      createdAt: hoursAgo(4) },
    { appSlug: 'staging-demo-notes', sessionId: 'demo-4', id: -101, parentId: null,
      username: 'staging-demo-omar',
      body: 'Staging demo comment: how does this affect existing shortcuts?',
      createdAt: hoursAgo(2) },
    { appSlug: 'staging-demo-notes', sessionId: 'demo-4', id: -102, parentId: -101,
      username: 'staging-demo-priya',
      body: 'Staging demo reply: only the new panel keys change.',
      createdAt: hoursAgo(1) },
  ];
}

// One thread, oldest first: fixtures for the session plus anything posted
// here during the preview, merged and ordered by time (then id) so the
// newest comment is always last.
function demoThreadRows(appSlug, sessionId) {
  const fixtures = demoCommentFixtures()
    .filter((c) => c.appSlug === appSlug && c.sessionId === sessionId);
  const stored = demoCommentStore.get(appSlug + '|' + sessionId) || [];
  return fixtures.concat(stored).sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
}

function findDemoComment(appSlug, sessionId, id) {
  for (const c of demoThreadRows(appSlug, sessionId)) {
    if (c.id === id) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// The inbox: every open promoted proposal across Homeroom apps, most
// votes-needed first, plus the caller's own recorded votes.
app.get('/api/inbox', async (req, res) => {
  const userToken = userTokenFrom(req);
  try {
    // The demo inbox is a fixed fixture, myVote included: the fixture's own
    // values are the demo truth, so the demo vote hook's persisted my_votes
    // rows are deliberately NOT overlaid here (they surface on the plain
    // My Votes route instead). Overlaying them made every load answer
    // differently depending on what a previous load had cast — one check's
    // cast vote hid another check's vote buttons. The caller's persisted
    // snooze rows follow the same rule: they are only overlaid when the load
    // opts in with ?snooze=1 (the marker the snooze checks' reloaded pages
    // carry), so a leftover snooze from one check can never reach another
    // check's plain ?demo=1 load. Production always stamps.
    if (req.query.demo === '1' && IS_STAGING) {
      const demo = demoInboxPayload(req);
      await applyDemoSnoozeFixtures(req);
      await finishDemoInbox(req, demo);
      return res.json(demo);
    }
    if (!PLATFORM_ORIGIN) {
      // A staging container without the platform origin only exists under a
      // plain local launch; keep the screen reviewable there with fixtures.
      if (IS_STAGING) {
        const demo = demoInboxPayload(req);
        await applyDemoSnoozeFixtures(req);
        await finishDemoInbox(req, demo);
        return res.json(demo);
      }
      return res.status(500).json({ error: 'Platform origin is not configured' });
    }

    const apps = await loadApps(userToken);
    if (!apps) {
      return res.status(502).json({ error: 'Could not load the app list from the platform' });
    }

    const results = await mapLimited(
      apps, PROMOTED_CONCURRENCY,
      (a) => loadPromoted(a.slug, userToken),
      Date.now() + INBOX_BUDGET_MS);

    const proposals = [];
    let failures = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        for (const p of r.value) {
          proposals.push({ ...p, appName: apps[i].name, icon: apps[i].icon || null });
        }
      } else {
        failures++;
      }
    });

    await withMyVotes(proposals, req.user.id);
    await withMySnoozes(proposals, req.user.id);
    await withMyStars(proposals, req.user.id, req);

    // Most votes-needed first; unknown requirement last, then fewest yes.
    proposals.sort(neededFirst);

    // Where each approved proposal sits in its app's merge queue (1 =
    // next to merge); voting and merged proposals are left unstamped.
    stampQueuePositions(proposals);

    // Celebrations for proposals the caller voted on that are now merged:
    // record the new ones (once), then return the caller's pending cards.
    await syncMergeCelebrations(proposals, req.user);
    const celebrations = await pendingCelebrations(req.user.id);

    const filterApps = [];
    const seen = new Set();
    for (const p of proposals) {
      if (!seen.has(p.appSlug)) {
        seen.add(p.appSlug);
        filterApps.push({ slug: p.appSlug, name: p.appName, icon: p.icon || null });
      }
    }

    res.json({
      demo: false,
      apps: filterApps,
      proposals,
      celebrations,
      failures,
      totalApps: apps.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-tap vote. Calls the platform's session vote endpoint AS the user
// (Bearer-forwarded token), then records the vote locally for My Votes.
app.post('/api/vote', async (req, res) => {
  const userToken = userTokenFrom(req);
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  const choice = body.choice;
  if (!sessionId || (choice !== 'yes' && choice !== 'no')) {
    return res.status(400).json({ error: 'sessionId and choice (yes or no) are required' });
  }
  try {
    if (body.demo === true) {
      // Demo proposals only exist in staging fixtures; record locally so the
      // vote → My Votes flow is testable without the platform.
      if (!IS_STAGING) return res.status(400).json({ error: 'Demo voting is staging-only' });
      await recordVote({
        userId: req.user.id,
        username: req.user.username,
        appSlug: body.appSlug || 'staging-demo-app',
        appName: body.appName || 'Staging Demo App',
        sessionId,
        proposalId: body.proposalId || null,
        title: body.title || 'Staging demo proposal',
        choice,
        yes: Number.isFinite(body.yes) ? body.yes : 0,
        no: Number.isFinite(body.no) ? body.no : 0,
        required: Number.isFinite(body.required) ? body.required : null,
      });
      return res.json({ ok: true, demo: true });
    }

    if (!PLATFORM_ORIGIN) {
      return res.status(500).json({ error: 'Platform origin is not configured' });
    }
    const r = await platformFetch(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/vote',
      { method: 'POST', userToken, body: { choice } });
    if (!r.ok) {
      // 401 here means the PLATFORM rejected the forwarded sign-in, not that
      // this app's caller is unauthenticated — surface it as an upstream
      // failure rather than leaking it as a local auth error.
      const status = r.status === 401 ? 502 : r.status;
      const message = (r.data && (r.data.error || r.data.message))
        || (r.status === 409 ? 'You already voted on this proposal' : 'Vote failed');
      return res.status(status).json({ error: message, platformStatus: r.status });
    }
    await recordVote({
      userId: req.user.id,
      username: req.user.username,
      appSlug: body.appSlug || '',
      appName: body.appName || '',
      sessionId,
      proposalId: body.proposalId || null,
      title: body.title || 'Untitled proposal',
      choice,
      yes: Number.isFinite(body.yes) ? body.yes : 0,
      no: Number.isFinite(body.no) ? body.no : 0,
      required: Number.isFinite(body.required) ? body.required : null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Undo: remove this app's record of the caller's vote on one session, so it
// no longer shows as cast here and the user can vote again. Only the local
// history row is deleted; the platform's own tally stays authoritative and
// is refetched on the next inbox load.
app.post('/api/unvote', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM my_votes WHERE user_id = $1 AND session_id = $2',
      [req.user.id, sessionId]);
    res.json({ ok: true, removed: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// My Votes: everything the signed-in user voted on through this app, with a
// best-effort merge-status refresh for still-open proposals.
app.get('/api/my-votes', async (req, res) => {
  const userToken = userTokenFrom(req);
  const select = `
    SELECT id, app_slug, app_name, session_id, proposal_id, title, choice,
           status, votes_for, votes_against, votes_required, created_at,
           updated_at, merged_at
    FROM my_votes WHERE user_id = $1 ORDER BY created_at DESC`;
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      // Demo mode is a fixed fixture: exactly the three demo rows, so the
      // summary line and the declared checks ("3 voted, 1 merged") are
      // deterministic run to run. The caller's real history, including rows
      // the ?cast= demo hook persists for the vote → Undo check, is served
      // by the plain route below, not mixed in here. ?no-votes=1 empties the
      // fixture so the share-image empty-history card is reachable by checks.
      const digestKind = req.query.digest;
      if (digestKind === 'week' || digestKind === 'quiet') {
        // Weekly-digest fixture variant (see demoDigestRows): rows spread
        // across known weeks so the digest card's numbers are checkable.
        return res.json({ demo: true, username: req.user.username, votes: demoDigestRows(digestKind) });
      }
      const votes = req.query['no-votes'] === '1' ? [] : demoVoteRows();
      return res.json({ demo: true, username: req.user.username, votes });
    }

    const { rows } = await pool.query(select, [req.user.id]);
    const open = rows.filter((r) => r.status === 'voting' || r.status === 'merging');

    // Refresh statuses for open proposals: still listed means still voting;
    // dropped from the promoted list means the vote ended. Apps the platform
    // will not answer for are left at their last known state.
    if (PLATFORM_ORIGIN && open.length) {
      const updates = [];
      const slugs = [...new Set(open.map((r) => r.app_slug))];
      for (const slug of slugs) {
        let items = null;
        try { items = await loadPromoted(slug, userToken); } catch { items = null; }
        if (!items) continue;
        const bySession = new Map(items.map((i) => [i.sessionId, i]));
        for (const row of open.filter((r) => r.app_slug === slug)) {
          const item = bySession.get(row.session_id);
          if (item) {
            // Trust the status the platform reports ('merging' or 'merged');
            // anything else still means the vote is open. 'merged' also
            // carries the merged date the My Votes row shows: record it the
            // first time the row is seen merged, and keep it from then on.
            updates.push([row.id,
                          item.status === 'merging' || item.status === 'merged'
                            ? item.status : 'voting',
                          item.yes, item.no,
                          item.status === 'merged' && row.merged_at == null
                            ? item.mergedAt : null]);
          } else {
            updates.push([row.id, 'closed', row.votes_for, row.votes_against]);
          }
        }
      }
      if (updates.length) {
        for (const [id, status, yes, no, mergedAt] of updates) {
          await pool.query(
            'UPDATE my_votes SET status = $2, votes_for = $3, votes_against = $4, merged_at = COALESCE($5, merged_at), updated_at = NOW() WHERE id = $1',
            [id, status, yes, no, mergedAt]);
        }
        const { rows: fresh } = await pool.query(select, [req.user.id]);
        return res.json({ demo: false, username: req.user.username, votes: fresh });
      }
    }

    res.json({ demo: false, username: req.user.username, votes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Watchlist: proposals the signed-in user starred, each with its current
// status and the status it was last seen in, so the tab can badge what
// changed since the last look.
app.get('/api/watchlist', async (req, res) => {
  const userToken = userTokenFrom(req);
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      const demo = demoWatchlistPayload(req);
      // ?watch-mine=1 (demo checks) adds the caller's own real rows, recorded
      // through the ?set-star= hook, so one URL observes star → reload →
      // still starred from actual storage. Without it the demo payload stays
      // the pure fixture, keeping the other watchlist checks deterministic.
      if (req.query['watch-mine'] === '1') {
        const { rows } = await pool.query(
          `SELECT app_slug, app_name, session_id, proposal_id, title,
                  last_seen_status, starred_at
           FROM watchlist WHERE user_id = $1 ORDER BY starred_at DESC`,
          [req.user.id]);
        const present = new Set(demo.rows.map((r) => r.sessionId));
        const fixtureById = new Map(demoWatchRows().map((r) => [r.sessionId, r]));
        for (const r of rows) {
          if (present.has(r.session_id)) continue;
          const fixture = fixtureById.get(r.session_id);
          const status = fixture ? fixture.status
            : (r.last_seen_status || 'voting');
          demo.rows.unshift({
            sessionId: r.session_id,
            appSlug: r.app_slug,
            appName: r.app_name || r.app_slug,
            icon: fixture ? fixture.icon : null,
            proposalId: r.proposal_id,
            title: r.title,
            starredAt: r.starred_at,
            seenStatus: r.last_seen_status,
            status,
            changed: r.last_seen_status != null && status !== r.last_seen_status,
          });
        }
      }
      return res.json(demo);
    }

    const { rows } = await pool.query(
      `SELECT app_slug, app_name, session_id, proposal_id, title,
              last_seen_status, starred_at
       FROM watchlist WHERE user_id = $1 ORDER BY starred_at DESC`,
      [req.user.id]);
    await withCurrentStatuses(rows, userToken);
    res.json({ demo: false, rows: rows.map(watchRowPayload) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Discussion threads
//
// One thread per proposal, keyed by the proposal's app slug + session id
// (the same pair the inbox uses). Comments are authenticated: they are
// stored as the signed-in member who wrote them. Replies are one level
// deep, enforced here at write time — a reply to a reply is filed under
// that reply's top-level parent instead.
// ---------------------------------------------------------------------------

const MAX_COMMENT_LEN = 2000;

function normalizeComment(row) {
  return {
    id: row.id,
    parentId: row.parent_id == null ? null : row.parent_id,
    username: row.username,
    body: row.body,
    createdAt: row.created_at,
  };
}

app.get('/api/comments', async (req, res) => {
  const appSlug = typeof req.query.appSlug === 'string' ? req.query.appSlug.slice(0, 255) : '';
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.slice(0, 128) : '';
  if (!appSlug || !sessionId) {
    return res.status(400).json({ error: 'appSlug and sessionId are required' });
  }
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      return res.json({ demo: true, comments: demoThreadRows(appSlug, sessionId) });
    }
    const { rows } = await pool.query(
      `SELECT id, parent_id, username, body, created_at
       FROM proposal_comments
       WHERE app_slug = $1 AND session_id = $2
       ORDER BY created_at ASC, id ASC`,
      [appSlug, sessionId]);
    res.json({ demo: false, comments: rows.map(normalizeComment) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Star a proposal. Demo bodies (staging only) carry just the session id and
// take their metadata from the demo fixture, so a check URL can star a
// known proposal; real stars carry what the card showed. Starred again with
// the row already there is a no-op.
app.post('/api/watchlist/star', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    let meta = body;
    if (body.demo === true) {
      if (!IS_STAGING) return res.status(400).json({ error: 'Demo starring is staging-only' });
      const p = demoInbox().proposals.find((x) => x.sessionId === sessionId);
      if (!p) return res.status(400).json({ error: 'Unknown demo proposal' });
      meta = {
        appSlug: p.appSlug,
        appName: p.appName,
        proposalId: p.proposalId,
        title: p.title,
        status: p.status === 'proposed' ? 'voting' : (p.status || 'voting'),
      };
    }
    await pool.query(`
      INSERT INTO watchlist
        (user_id, username, app_slug, app_name, session_id, proposal_id, title, last_seen_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, session_id) DO NOTHING
    `, [req.user.id, req.user.username, meta.appSlug || '', meta.appName || '',
        sessionId, meta.proposalId || null, meta.title || 'Untitled proposal',
        meta.status || 'voting']);
    res.json({ ok: true, demo: body.demo === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unstar: remove this user's row for one session.
app.post('/api/watchlist/unstar', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM watchlist WHERE user_id = $1 AND session_id = $2',
      [req.user.id, sessionId]);
    res.json({ ok: true, removed: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark watched: record the status each row showed at this view, so the next
// visit only badges what changed since. The frontend posts it after the tab
// renders. Rows that were unstarred meanwhile simply update nothing.
app.post('/api/watchlist/seen', async (req, res) => {
  const body = req.body || {};
  const statuses = Array.isArray(body.statuses) ? body.statuses.slice(0, 200) : [];
  try {
    for (const s of statuses) {
      if (!s || s.sessionId == null || typeof s.status !== 'string' || !s.status) continue;
      await pool.query(
        'UPDATE watchlist SET last_seen_status = $3 WHERE user_id = $1 AND session_id = $2',
        [req.user.id, String(s.sessionId), s.status]);
    }
    res.json({ ok: true, marked: statuses.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Saved searches: the user's saved inbox queries. Rows are per user
// (staging:private — one person's own searches and when they last opened
// each). The new-match counts are tallied on the client from the inbox it
// already loaded, no extra platform calls; the row only stores the query,
// its filters and the last-opened stamp.
// ---------------------------------------------------------------------------

const SAVED_SEARCH_FILTER_KEYS = ['filter', 'filterName', 'oneAway', 'hideVoted', 'hideMerged'];

// Keep only the known filter keys, in their expected types, so a saved
// search re-applies exactly what the screen saw and nothing else rides in.
function cleanSavedFilters(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const key of SAVED_SEARCH_FILTER_KEYS) {
      const v = raw[key];
      if (typeof v === 'string') out[key] = v.slice(0, 255);
      else if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

function savedSearchPayload(r) {
  return {
    id: r.id,
    name: r.name,
    query: r.query,
    filters: r.filters || {},
    lastSeenAt: r.last_seen_at,
  };
}

app.get('/api/saved-searches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, query, filters, last_seen_at
       FROM saved_searches WHERE user_id = $1 ORDER BY created_at, id`,
      [req.user.id]);
    res.json({ demo: false, rows: rows.map(savedSearchPayload) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save the current search. An empty name falls back to the search text so
// the chip is still labelled. A name the user already has (case ignored) is
// a no-op: the first saved search stays, `created: false` says so.
app.post('/api/saved-searches/save', async (req, res) => {
  const body = req.body || {};
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : '';
  let name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  if (!query) return res.status(400).json({ error: 'Type a search first' });
  if (!name) name = query.slice(0, 60);
  const filters = cleanSavedFilters(body.filters);
  try {
    const inserted = await pool.query(
      `INSERT INTO saved_searches (user_id, username, name, query, filters, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, lower(name)) DO NOTHING
       RETURNING id, name, query, filters, last_seen_at`,
      [req.user.id, req.user.username, name, query, filters]);
    if (inserted.rows.length) {
      return res.json({ ok: true, created: true, row: savedSearchPayload(inserted.rows[0]) });
    }
    const existing = await pool.query(
      'SELECT id, name, query, filters, last_seen_at FROM saved_searches WHERE user_id = $1 AND lower(name) = lower($2)',
      [req.user.id, name]);
    return res.json({
      ok: true,
      created: false,
      row: existing.rows[0] ? savedSearchPayload(existing.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/saved-searches/delete', async (req, res) => {
  const body = req.body || {};
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'id is required' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM saved_searches WHERE user_id = $1 AND id = $2',
      [req.user.id, id]);
    res.json({ ok: true, removed: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Opening a chip counts as opening the saved search: stamp now, so only
// proposals that went up for vote after this moment count as new next time.
app.post('/api/saved-searches/seen', async (req, res) => {
  const body = req.body || {};
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'id is required' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE saved_searches SET last_seen_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING last_seen_at',
      [req.user.id, id]);
    res.json({ ok: true, lastSeenAt: rows[0] ? rows[0].last_seen_at : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staging-only fixture seeding for the declared checks (like demo starring):
// replaces the caller's saved searches with the named demo rows, each last
// opened three days ago so the new-match counts are deterministic against
// the demo inbox fixture's ages. Unknown names (for example `none`) insert
// nothing, which leaves the list empty.
const SAVED_SEARCH_SEEDS = {
  Weekly: { query: 'weekly', filters: {} },
  'All demo': { query: 'staging demo', filters: {} },
};

app.post('/api/saved-searches/seed', async (req, res) => {
  const body = req.body || {};
  if (!IS_STAGING) return res.status(400).json({ error: 'Demo seeding is staging-only' });
  const names = Array.isArray(body.names)
    ? body.names.filter((n) => typeof n === 'string' && n.trim()) : [];
  // One transaction under a per-user advisory lock: check groups run in
  // parallel against the same shared staging account, and a bare
  // DELETE + INSERT pair races two concurrent seeds into unique-index
  // violations (500s) and torn fixture lists.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('vote-inbox:saved-searches:' || $1::text))`,
      [String(req.user.id)]);
    await client.query('DELETE FROM saved_searches WHERE user_id = $1', [req.user.id]);
    for (const name of names) {
      const seed = SAVED_SEARCH_SEEDS[name.trim()];
      if (!seed) continue;
      await client.query(
        `INSERT INTO saved_searches (user_id, username, name, query, filters, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '3 days')
         ON CONFLICT (user_id, lower(name)) DO UPDATE
           SET query = EXCLUDED.query, filters = EXCLUDED.filters,
               last_seen_at = EXCLUDED.last_seen_at`,
        [req.user.id, req.user.username, name.trim(), seed.query, seed.filters]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Snooze a proposal for N days: the card leaves the caller's inbox until the
// wake date, then reappears (the read drops expired rows). Re-snoozing the
// same proposal moves the wake date. Demo bodies (staging only) carry just
// the session id and days, and take their metadata from the demo fixture, so
// a check URL can snooze a known proposal; real snoozes carry what the card
// showed. Snoozing is per user and never touches the vote or merge state.
app.post('/api/snooze', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  const days = Number(body.days);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return res.status(400).json({ error: 'Snooze length must be between 1 and 365 days' });
  }
  try {
    let meta = body;
    if (body.demo === true) {
      if (!IS_STAGING) return res.status(400).json({ error: 'Demo snoozing is staging-only' });
      const p = demoInbox().proposals.find((x) => x.sessionId === sessionId);
      if (!p) return res.status(400).json({ error: 'Unknown demo proposal' });
      meta = {
        appSlug: p.appSlug,
        appName: p.appName,
        proposalId: p.proposalId,
        title: p.title,
      };
    }
    await pool.query(`
      INSERT INTO snoozes
        (user_id, username, app_slug, app_name, session_id, proposal_id, title, wake_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(days => $8::int))
      ON CONFLICT (user_id, session_id) DO UPDATE
        SET wake_at = EXCLUDED.wake_at,
            title = EXCLUDED.title,
            app_slug = EXCLUDED.app_slug,
            app_name = EXCLUDED.app_name,
            proposal_id = EXCLUDED.proposal_id
    `, [req.user.id, req.user.username, meta.appSlug || '', meta.appName || '',
        sessionId, meta.proposalId || null, meta.title || 'Untitled proposal',
        Math.round(days)]);
    res.json({ ok: true, demo: body.demo === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unsnooze: remove this user's row for one session, so the proposal is back
// in the inbox on the very next render.
app.post('/api/unsnooze', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM snoozes WHERE user_id = $1 AND session_id = $2',
      [req.user.id, sessionId]);
    res.json({ ok: true, removed: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark celebration cards shown. The frontend calls this right after the
// cards render, so each proposal's celebration is a one-time card: the next
// inbox load no longer returns it. Only the caller's own rows are touched.
app.post('/api/celebrations/shown', async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids)
    ? body.ids.map((s) => String(s)).filter(Boolean)
    : [];
  if (!ids.length) return res.json({ ok: true, updated: 0 });
  try {
    const { rowCount } = await pool.query(
      'UPDATE merge_celebrations SET shown = TRUE WHERE user_id = $1 AND session_id = ANY($2)',
      [req.user.id, ids]);
    res.json({ ok: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss one celebration: the card leaves the inbox now and the row is
// marked dismissed, so the proposal never celebrates again.
app.post('/api/celebrations/dismiss', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId != null ? String(body.sessionId) : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE merge_celebrations SET dismissed = TRUE, shown = TRUE WHERE user_id = $1 AND session_id = $2',
      [req.user.id, sessionId]);
    res.json({ ok: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/comments', async (req, res) => {
  const body = req.body || {};
  const appSlug = typeof body.appSlug === 'string' ? body.appSlug.trim().slice(0, 255) : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 128) : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!appSlug || !sessionId) {
    return res.status(400).json({ error: 'appSlug and sessionId are required' });
  }
  if (!text) return res.status(400).json({ error: 'Write a comment first' });
  if (text.length > MAX_COMMENT_LEN) {
    return res.status(400).json({ error: 'Comments are capped at 2000 characters' });
  }
  let parentId = null;
  if (body.parentId != null) {
    parentId = Number(body.parentId);
    if (!Number.isInteger(parentId)) {
      return res.status(400).json({ error: 'parentId must be a comment id' });
    }
  }
  // Demo mode is staging-only, like the demo vote path: the comment is
  // recorded in server memory so the posting flow is testable without
  // writing preview rows into the database.
  const demo = body.demo === true && IS_STAGING;
  try {
    if (parentId != null) {
      const parent = demo
        ? findDemoComment(appSlug, sessionId, parentId)
        : (await pool.query(
            'SELECT id, parent_id FROM proposal_comments WHERE id = $1 AND app_slug = $2 AND session_id = $3',
            [parentId, appSlug, sessionId])).rows[0] || null;
      if (!parent) {
        return res.status(404).json({ error: 'The comment you replied to no longer exists' });
      }
      // One level only: a reply to a reply is filed under that reply's own
      // top-level parent, so replies never nest deeper than one level.
      const parentParent = demo ? parent.parentId : parent.parent_id;
      if (parentParent != null) parentId = parentParent;
    }
    if (demo) {
      const row = {
        id: demoCommentSeq--,
        parentId,
        username: req.user.username,
        body: text,
        createdAt: new Date().toISOString(),
      };
      const key = appSlug + '|' + sessionId;
      const list = demoCommentStore.get(key) || [];
      list.push(row);
      demoCommentStore.set(key, list);
      return res.status(201).json({ ok: true, demo: true, comment: row });
    }
    const { rows } = await pool.query(
      `INSERT INTO proposal_comments (app_slug, session_id, parent_id, user_id, username, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, parent_id, username, body, created_at`,
      [appSlug, sessionId, parentId, req.user.id, req.user.username, text]);
    return res.status(201).json({ ok: true, comment: normalizeComment(rows[0]) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Members directory
//
// The roster comes from the platform's own member list (GET /members on the
// app-facing API), read with the caller's forwarded identity — the platform
// answers only for actual members of the project, so a non-member (the check
// runner, an admin looking in) gets an explicit notMember flag and the screen
// explains itself instead of failing. Fields the platform does not document
// per member (joined date, accepted-proposal count) are passed through under
// any usual spelling when the response carries them and stay null when it
// does not, so the row simply omits them — the same optional-field contract
// normalizeProposal uses. Votes cast come from this app's own my_votes
// history aggregated per username: counts only, the rows themselves stay
// private (my_votes is staging:private).
// ---------------------------------------------------------------------------

const MEMBER_ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;

function pickString(raw, keys) {
  for (const k of keys) {
    if (raw && typeof raw[k] === 'string' && raw[k]) return raw[k];
  }
  return null;
}

function pickInt(raw, keys) {
  for (const k of keys) {
    const v = raw && raw[k];
    if (Number.isInteger(v) && v >= 0) return v;
  }
  return null;
}

// One member row in the shape the frontend renders. `extra` carries the
// stats derived from this app's own data when the platform response itself
// did not name them. The owner chip follows the platform's documented
// /members order (the creator first, then oldest member first), so the
// first listed member is the creator.
function memberPayload(raw, extra) {
  const username = typeof raw === 'string' ? raw.trim()
    : raw && typeof raw.username === 'string' ? raw.username.trim() : '';
  if (!username) return null;
  const id = raw && typeof raw === 'object' && raw.id != null ? raw.id : null;
  let profileUrl = null;
  if (PLATFORM_ORIGIN) {
    profileUrl = PLATFORM_ORIGIN + '/u/' + encodeURIComponent(username);
  } else if (extra && extra.demo) {
    // No platform origin at runtime (a bare local launch): the demo
    // stand-in keeps the rows' profile links shaped like the real ones
    // without naming a host that could go stale.
    profileUrl = 'https://staging-demo.invalid/u/' + encodeURIComponent(username);
  }
  return {
    id,
    username,
    role: extra && extra.owner ? 'owner' : 'member',
    joinedAt: pickString(raw, ['joined_at', 'joinedAt', 'member_since', 'memberSince', 'created_at', 'createdAt']),
    votesCast: pickInt(raw, ['votes_cast', 'votesCast']) != null
      ? pickInt(raw, ['votes_cast', 'votesCast'])
      : (extra && extra.votesCast != null ? extra.votesCast : null),
    proposalsAccepted: pickInt(raw, ['proposals_accepted', 'proposalsAccepted', 'accepted_proposals', 'acceptedProposals', 'accepted_count']),
    lastActiveAt: pickString(raw, ['last_active_at', 'lastActiveAt', 'last_seen_at', 'lastSeenAt']) != null
      ? pickString(raw, ['last_active_at', 'lastActiveAt', 'last_seen_at', 'lastSeenAt'])
      : (extra && extra.lastActiveAt != null ? extra.lastActiveAt : null),
    profileUrl,
  };
}

function membersPayload(rows, now, opts) {
  const demo = !!(opts && opts.demo);
  const members = [];
  rows.forEach((raw, i) => {
    const extra = opts && opts.extra ? opts.extra(raw, i) : null;
    const m = memberPayload(raw, { owner: i === 0, demo, ...(extra || {}) });
    if (m) members.push(m);
  });
  const cutoff = now.getTime() - MEMBER_ACTIVE_WINDOW_MS;
  let activeThisWeek = 0;
  for (const m of members) {
    const t = m.lastActiveAt ? Date.parse(m.lastActiveAt) : NaN;
    if (isFinite(t) && t >= cutoff) activeThisWeek++;
  }
  return { members, activeThisWeek };
}

// Staging demo roster (?demo=1): six obviously-fake members in the platform's
// documented order (creator first, so the owner chip lands on
// staging-demo-user), covering both chips, joined dates, vote and accepted
// counts, and the active/inactive split (four active within the last seven
// days, two not). Request-time injection, staging only; the field spellings
// match the platform's, so the demo rows go through the same normalizer the
// live response does.
function demoMemberRows(now) {
  const ago = (days) => new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  return [
    { id: 900001, username: 'staging-demo-user', joined_at: ago(120), votes_cast: 14, proposals_accepted: 3, last_active_at: ago(0.25) },
    { id: 900002, username: 'staging-demo-maya', joined_at: ago(95), votes_cast: 9, proposals_accepted: 2, last_active_at: ago(1) },
    { id: 900003, username: 'staging-demo-omar', joined_at: ago(80), votes_cast: 6, proposals_accepted: 1, last_active_at: ago(3) },
    { id: 900004, username: 'staging-demo-priya', joined_at: ago(60), votes_cast: 4, proposals_accepted: 1, last_active_at: ago(6) },
    { id: 900005, username: 'staging-demo-quinn', joined_at: ago(45), votes_cast: 2, proposals_accepted: 0, last_active_at: ago(9) },
    { id: 900006, username: 'staging-demo-raul', joined_at: ago(30), votes_cast: 1, proposals_accepted: 0, last_active_at: ago(21) },
  ];
}

function demoMembersPayload(req) {
  return { demo: true, ...membersPayload(demoMemberRows(req.now), req.now, { demo: true }) };
}

// The project's roster, read the way /api/members reads it: the caller's
// forwarded identity (the platform answers only for actual members) and, in
// production, the app token. Returns { list }, { notMember: true } for a
// non-member, or { error } when the platform answered unusably.
async function loadRosterList(req) {
  const headers = { 'x-usernode-user-token': userTokenFrom(req) };
  if (APP_TOKEN) headers['x-usernode-app-token'] = APP_TOKEN;
  const r = await fetch(PLATFORM_API_BASE + '/members?limit=200', {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (r.status === 403) {
    // Only members of the project get the roster. Everyone else gets an
    // explicit flag so the screen can show why it is empty.
    return { notMember: true };
  }
  if (!r.ok) {
    return { error: 'Could not load the member list from the platform' };
  }
  const data = await r.json().catch(() => null);
  const list = Array.isArray(data) ? data
    : data && Array.isArray(data.members) ? data.members : null;
  if (!list) {
    return { error: 'Unexpected member list response' };
  }
  return { list };
}

app.get('/api/members', async (req, res) => {
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      return res.json(demoMembersPayload(req));
    }
    if (!PLATFORM_API_BASE) {
      // A staging container without the platform API only exists under a
      // plain local launch; keep the screen reviewable there with fixtures.
      if (IS_STAGING) return res.json(demoMembersPayload(req));
      return res.status(500).json({ error: 'Platform API is not configured' });
    }
    const roster = await loadRosterList(req);
    if (roster.notMember) {
      return res.json({ demo: false, notMember: true, members: [], activeThisWeek: 0 });
    }
    if (roster.error) {
      return res.status(502).json({ error: roster.error });
    }
    const list = roster.list;
    // Votes cast through this app, aggregated per member — the app's own
    // recorded history, not a guess. A query failure just leaves the counts
    // off the rows (the optional-field contract), never fails the roster.
    let stats = new Map();
    try {
      const { rows } = await pool.query(
        `SELECT username, COUNT(*)::int AS votes, MAX(created_at) AS last_vote
         FROM my_votes GROUP BY username`);
      stats = new Map(rows.map((s) => [String(s.username).toLowerCase(), s]));
    } catch {}
    const payload = membersPayload(list, req.now, {
      extra: (raw) => {
        const username = (typeof raw === 'string' ? raw
          : raw && typeof raw.username === 'string' ? raw.username : '').trim();
        const s = stats.get(username.toLowerCase());
        if (!s) return null;
        return {
          votesCast: s.votes,
          lastActiveAt: s.last_vote ? new Date(s.last_vote).toISOString() : null,
        };
      },
    });
    return res.json({ demo: false, ...payload });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Voters leaderboard
//
// Members ranked by the votes they cast through this app: the same my_votes
// history My Votes reads, aggregated per member — counts only, the rows
// themselves stay private (my_votes is staging:private). The roster comes
// from the platform's member list (only members get an answer, so a
// non-member gets the same explicit notMember flag the directory does), and
// each member carries both ranges' counts (this week and all time) so the
// This week / All time toggle re-ranks the loaded rows without a refetch.
// "This week" is the same rolling seven-day window the directory's
// active-this-week count uses, read through req.now.
// ---------------------------------------------------------------------------

// One aggregated member row in the shape the frontend renders. `you` marks
// the signed-in caller's own row; it rides on the row so the client can
// highlight and pin it without knowing its own username.
function leaderboardRow(username, s) {
  return {
    username,
    weekVotes: s.week_votes,
    weekMerged: s.week_merged,
    allVotes: s.all_votes,
    allMerged: s.all_merged,
  };
}

const LEADERBOARD_AGGREGATE = `
  SELECT username,
         COUNT(*)::int AS all_votes,
         (COUNT(*) FILTER (WHERE status = 'merged'))::int AS all_merged,
         (COUNT(*) FILTER (WHERE created_at >= $1))::int AS week_votes,
         (COUNT(*) FILTER (WHERE status = 'merged' AND created_at >= $1))::int AS week_merged
  FROM my_votes`;

// Aggregate the signed-in caller's own vote history into one leaderboard row
// (or null when they have not voted at all). Used by the demo overlay: the
// fixture roster is fake, the caller's row is their real recorded votes.
async function myLeaderboardStats(userId, cutoff) {
  try {
    const { rows } = await pool.query(
      LEADERBOARD_AGGREGATE + ' WHERE user_id = $2 GROUP BY username', [cutoff, userId]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Staging demo fixture (?demo=1): the same six obviously-fake members the
// members directory previews with, with fixed week and all-time counts. The
// numbers make each check point observable: staging-demo-user leads both
// ranges; quinn and priya tie on this week's votes (2) and the tie is broken
// by merged votes (1 > 0), while all time priya (4) sits above quinn (2), so
// the range toggle visibly reorders; raul never voted, so the footer chip
// reads "5 of 6 members have voted". Request-time injection, staging only.
function demoLeaderboardFixture() {
  return [
    { username: 'staging-demo-user', weekVotes: 5, weekMerged: 1, allVotes: 14, allMerged: 3 },
    { username: 'staging-demo-maya', weekVotes: 4, weekMerged: 2, allVotes: 9, allMerged: 2 },
    { username: 'staging-demo-omar', weekVotes: 3, weekMerged: 0, allVotes: 6, allMerged: 1 },
    { username: 'staging-demo-quinn', weekVotes: 2, weekMerged: 1, allVotes: 2, allMerged: 1 },
    { username: 'staging-demo-priya', weekVotes: 2, weekMerged: 0, allVotes: 4, allMerged: 1 },
    { username: 'staging-demo-raul', weekVotes: 0, weekMerged: 0, allVotes: 0, allMerged: 0 },
  ];
}

// Fixture variants for the checks (staging + ?demo=1 only): ?lb-many=1 makes
// a 60-member board so the 50-row cap is observable; ?lb-tie=1 shrinks the
// board to two members tied on votes with different merged counts; ?lb-empty=1
// zeroes every member's week so the empty-week state renders.
function demoLeaderboardRowsFor(req) {
  if (req.query['lb-many'] === '1') {
    const rows = [];
    for (let n = 1; n <= 60; n++) {
      const name = 'staging-demo-lb-' + (n < 10 ? '0' + n : n);
      rows.push({ username: name, weekVotes: 61 - n, weekMerged: 0, allVotes: 61 - n, allMerged: 0 });
    }
    return rows;
  }
  if (req.query['lb-tie'] === '1') {
    return [
      { username: 'staging-demo-tie-a', weekVotes: 4, weekMerged: 1, allVotes: 4, allMerged: 1 },
      { username: 'staging-demo-tie-b', weekVotes: 4, weekMerged: 2, allVotes: 4, allMerged: 2 },
    ];
  }
  if (req.query['lb-empty'] === '1') {
    return demoLeaderboardFixture().map((r) => ({ ...r, weekVotes: 0, weekMerged: 0 }));
  }
  return demoLeaderboardFixture();
}

async function demoLeaderboardPayload(req) {
  const rows = demoLeaderboardRowsFor(req).map((r) => ({ ...r }));
  // The chip counts members who have voted at all (all time), so it stays
  // put across the range toggle and the empty-week variant.
  let totalMembers = rows.length;
  let voters = rows.filter((r) => r.allVotes > 0).length;
  // ?lb=1 overlays the caller's own aggregated row on the fixture — their
  // real recorded votes, the way the my_votes route serves them — so the
  // own-row highlight, the pin and the after-a-fresh-vote update are
  // reachable in a preview. ?lb-clear=1 first deletes the caller's demo-cast
  // rows (the way the bulk hooks unvote before acting), so a check run that
  // shares its staging database still starts from a known count.
  if (req.query.lb === '1') {
    if (req.query['lb-clear'] === '1') {
      try {
        await pool.query(
          "DELETE FROM my_votes WHERE user_id = $1 AND app_slug LIKE 'staging-demo%'",
          [req.user.id]);
      } catch {}
    }
    const cutoff = new Date(req.now.getTime() - MEMBER_ACTIVE_WINDOW_MS);
    const s = await myLeaderboardStats(req.user.id, cutoff);
    if (s && s.all_votes > 0) {
      rows.push({ ...leaderboardRow(req.user.username, s), you: true });
      totalMembers += 1;
      voters += 1;
    }
  }
  return { demo: true, rows, totalMembers, voters };
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      return res.json(await demoLeaderboardPayload(req));
    }
    if (!PLATFORM_API_BASE) {
      // A staging container without the platform API only exists under a
      // plain local launch; keep the screen reviewable there with fixtures.
      if (IS_STAGING) return res.json(await demoLeaderboardPayload(req));
      return res.status(500).json({ error: 'Platform API is not configured' });
    }
    const roster = await loadRosterList(req);
    if (roster.notMember) {
      return res.json({ demo: false, notMember: true, rows: [], totalMembers: 0, voters: 0 });
    }
    if (roster.error) {
      return res.status(502).json({ error: roster.error });
    }
    const cutoff = new Date(req.now.getTime() - MEMBER_ACTIVE_WINDOW_MS);
    let stats = new Map();
    try {
      const { rows } = await pool.query(
        LEADERBOARD_AGGREGATE + ' GROUP BY username', [cutoff]);
      stats = new Map(rows.map((s) => [String(s.username).toLowerCase(), s]));
    } catch {}
    const me = String(req.user.username || '').trim().toLowerCase();
    const rows = [];
    let voters = 0;
    let seenMe = false;
    for (const raw of roster.list) {
      const username = (typeof raw === 'string' ? raw
        : raw && typeof raw.username === 'string' ? raw.username : '').trim();
      if (!username) continue;
      const s = stats.get(username.toLowerCase());
      if (!s || !s.all_votes) continue;
      voters++;
      const you = me && username.toLowerCase() === me;
      if (you) seenMe = true;
      rows.push({ ...leaderboardRow(username, s), you });
    }
    // The caller is always a member (the roster answered), but a roster
    // spelling mismatch would drop their row; fall back to their own stats
    // so their row and pin never depend on the roster's casing.
    if (!seenMe && me) {
      const s = stats.get(me);
      if (s && s.all_votes) {
        rows.push({ ...leaderboardRow(req.user.username, s), you: true });
      }
    }
    return res.json({ demo: false, rows, totalMembers: roster.list.length, voters });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/vote-inbox-f3d63a/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/vote-inbox-f3d63a/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The platform stops and replaces every container on each deploy with
// SIGTERM and a bounded grace period. Stop accepting connections, drain
// briefly, close the pool, exit — and answer /health with 503 while doing
// so anything polling readiness sees the container leaving rotation.
const DRAIN_MS = 3000;
let server = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    if (server.closeIdleConnections) server.closeIdleConnections();
    const t = setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
    }, DRAIN_MS);
    t.unref();
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('[shutdown] pool.end failed', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate();
  if (IS_STAGING) await seedStaging();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });