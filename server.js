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

// Promoted (open, up-for-vote) proposals for one app. The platform's field
// spellings are normalised here so the frontend deals with one shape.
function normalizeProposal(raw, appItem) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = raw.session_id ?? raw.sessionId
    ?? (raw.session && raw.session.id) ?? raw.id;
  if (sessionId === undefined || sessionId === null) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const yes = num(raw.votes_for) ?? num(raw.votesFor) ?? num(raw.yes_votes) ?? 0;
  const no = num(raw.votes_against) ?? num(raw.votesAgainst) ?? num(raw.no_votes) ?? 0;
  const required = num(raw.votes_required) ?? num(raw.votesRequired) ?? num(raw.required);
  const title = (typeof raw.title === 'string' && raw.title.trim())
    || (typeof raw.name === 'string' && raw.name.trim())
    || 'Untitled proposal';
  // When the proposal was made, for the relative-age label on cards.
  const proposedAt = [raw.proposed_at, raw.proposedAt, raw.created_at, raw.createdAt]
    .find((v) => typeof v === 'string' && v) || null;
  return {
    sessionId: String(sessionId),
    proposalId: raw.proposal_id != null ? String(raw.proposal_id)
      : raw.pr_number != null ? String(raw.pr_number) : null,
    title,
    author: typeof raw.author === 'string' ? raw.author
      : typeof raw.username === 'string' ? raw.username : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    eta: typeof raw.eta === 'string' ? raw.eta : null,
    proposedAt,
    appSlug: appItem.slug,
    appName: appItem.name,
    yes,
    no,
    required,
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
}

async function seedStaging() {
  // Fake identity only — never rows owned by whoever opens the preview.
  await pool.query(`
    INSERT INTO my_votes
      (user_id, username, app_slug, app_name, session_id, proposal_id, title, choice, status, votes_for, votes_against, votes_required)
    VALUES
      (900001, 'staging-demo-user', 'staging-demo-app', 'Staging Demo App', 'demo-seed-1', NULL,
       'Staging demo proposal: weekly summary email', 'yes', 'voting', 3, 1, 5),
      (900001, 'staging-demo-user', 'staging-demo-app', 'Staging Demo App', 'demo-seed-2', NULL,
       'Staging demo proposal: custom themes', 'no', 'merged', 6, 0, 5),
      (900001, 'staging-demo-user', 'staging-demo-notes', 'Staging Demo Notes', 'demo-seed-3', NULL,
       'Staging demo proposal: pinned notes', 'yes', 'closed', 4, 2, 5)
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

// Stamp each proposal with the caller's own recorded vote, if any.
async function withMyVotes(proposals, userId) {
  const mine = await myVotesMap(userId);
  for (const p of proposals) p.myVote = mine.get(p.sessionId) || null;
  return proposals;
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
  ];
  const mk = (slug, sessionId, title, yes, no, required, status, ageMs) => ({
    sessionId,
    proposalId: null,
    title,
    author: 'staging-demo-user',
    status: status || null,
    eta: null,
    proposedAt: ageMs != null ? new Date(Date.now() - ageMs).toISOString() : null,
    appSlug: slug,
    appName: apps.find((a) => a.slug === slug).name,
    icon: apps.find((a) => a.slug === slug).icon,
    yes,
    no,
    required,
    needed: required != null ? Math.max(0, required - yes) : null,
    myVote: null,
  });
  const H = 3600 * 1000;
  const D = 24 * H;
  const proposals = [
    mk('staging-demo-app', 'demo-2', 'Staging demo proposal: weekly summary email', 1, 0, 4, null, 3 * H),
    mk('staging-demo-notes', 'demo-4', 'Staging demo proposal: keyboard shortcuts', 0, 2, 3, null, 8 * H),
    mk('staging-demo-app', 'demo-1', 'Staging demo proposal: add a dark mode toggle', 3, 1, 5, null, 2 * D),
    mk('staging-demo-app', 'demo-3', 'Staging demo proposal: export to CSV', 4, 0, 4, 'merging', 5 * D),
    mk('staging-demo-notes', 'demo-5', 'Staging demo proposal: pinned notes', 2, 1, null, null, 9 * D),
  ];
  return { demo: true, apps, proposals, refreshedAt: new Date().toISOString() };
}

function demoVoteRows() {
  const row = (sessionId, appSlug, appName, title, choice, status, yes, no, required, at) => ({
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
  });
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 24 * 3600 * 1000).toISOString();
  return [
    row('demo-v1', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: weekly summary email', 'yes', 'voting', 3, 1, 5, daysAgo(1)),
    row('demo-v2', 'staging-demo-app', 'Staging Demo App',
        'Staging demo proposal: custom themes', 'no', 'merged', 6, 0, 5, daysAgo(4)),
    row('demo-v3', 'staging-demo-notes', 'Staging Demo Notes',
        'Staging demo proposal: pinned notes', 'yes', 'closed', 4, 2, 5, daysAgo(9)),
  ];
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// The inbox: every open promoted proposal across Homeroom apps, most
// votes-needed first, plus the caller's own recorded votes.
app.get('/api/inbox', async (req, res) => {
  const userToken = userTokenFrom(req);
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      const demo = demoInbox();
      await withMyVotes(demo.proposals, req.user.id);
      return res.json(demo);
    }
    if (!PLATFORM_ORIGIN) {
      // A staging container without the platform origin only exists under a
      // plain local launch; keep the screen reviewable there with fixtures.
      if (IS_STAGING) {
        const demo = demoInbox();
        await withMyVotes(demo.proposals, req.user.id);
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

    // Most votes-needed first; unknown requirement last, then fewest yes.
    proposals.sort((a, b) => {
      const an = a.needed == null ? -1 : a.needed;
      const bn = b.needed == null ? -1 : b.needed;
      if (an !== bn) return bn - an;
      if (a.yes !== b.yes) return a.yes - b.yes;
      return a.title.localeCompare(b.title);
    });

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
           status, votes_for, votes_against, votes_required, created_at
    FROM my_votes WHERE user_id = $1 ORDER BY created_at DESC`;
  try {
    if (req.query.demo === '1' && IS_STAGING) {
      const { rows } = await pool.query(select, [req.user.id]);
      return res.json({ demo: true, votes: rows.concat(demoVoteRows()) });
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
            updates.push([row.id, item.status === 'merging' ? 'merging' : 'voting',
                          item.yes, item.no]);
          } else {
            updates.push([row.id, 'closed', row.votes_for, row.votes_against]);
          }
        }
      }
      if (updates.length) {
        for (const [id, status, yes, no] of updates) {
          await pool.query(
            'UPDATE my_votes SET status = $2, votes_for = $3, votes_against = $4, updated_at = NOW() WHERE id = $1',
            [id, status, yes, no]);
        }
        const { rows: fresh } = await pool.query(select, [req.user.id]);
        return res.json({ demo: false, votes: fresh });
      }
    }

    res.json({ demo: false, votes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
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