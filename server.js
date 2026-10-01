const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

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
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

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

// ── Polls ─────────────────────────────────────────────────────────────────
// One-question polls with 2-4 options, one vote per user per poll.
// All three tables stay public: poll questions, options and tallies are
// content every user of the app already sees in the UI (same category as
// posts and leaderboards), and votes are attributed by platform username.

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      question VARCHAR(280) NOT NULL,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label VARCHAR(120) NOT NULL,
      position SMALLINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (poll_id, user_id)
    )
  `);
}

// Staging starts from a copy of production, so these tables are EMPTY there
// until this seed runs. Fixed ids, obviously-fake "Staging demo" questions,
// fake identities only (never the visitor), idempotent on every rebuild.
// The demo votes belong to fake voter ids, so nothing here fabricates an
// answer for the signed-in tester's own vote state.
async function seedStaging() {
  if (!IS_STAGING) return;
  await pool.query(`
    INSERT INTO polls (id, question, user_id, username) VALUES
      (1, 'Staging demo: quick lunch spot near the office?', 900001, 'staging-demo-user'),
      (2, 'Staging demo: best day for the weekly run club?', 900001, 'staging-demo-user'),
      (3, 'Staging demo: which color for the app accent?', 900002, 'staging-demo-user-2')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO poll_options (id, poll_id, label, position) VALUES
      (11, 1, 'Nasi goreng', 0), (12, 1, 'Sushi', 1), (13, 1, 'Burger', 2),
      (21, 2, 'Saturday morning', 0), (22, 2, 'Sunday evening', 1),
      (31, 3, 'Violet', 0), (32, 3, 'Teal', 1), (33, 3, 'Amber', 2)
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO poll_votes (poll_id, option_id, user_id, username) VALUES
      (1, 11, 900101, 'staging-demo-voter-1'),
      (1, 11, 900102, 'staging-demo-voter-2'),
      (1, 13, 900103, 'staging-demo-voter-3'),
      (2, 21, 900101, 'staging-demo-voter-1'),
      (3, 31, 900102, 'staging-demo-voter-2'),
      (3, 32, 900103, 'staging-demo-voter-3'),
      (3, 31, 900104, 'staging-demo-voter-4')
    ON CONFLICT (poll_id, user_id) DO NOTHING
  `);
  // The explicit-id seed leaves the SERIAL sequences behind; bump them so
  // the next user-created poll gets an id above the seeded ones.
  await pool.query(`SELECT setval(pg_get_serial_sequence('polls', 'id'), (SELECT MAX(id) FROM polls))`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('poll_options', 'id'), (SELECT MAX(id) FROM poll_options))`);
}

// One round trip per poll list/detail: options with their live vote counts
// stitched in as JSON, plus the poll's total.
const POLL_SELECT = `
  SELECT p.id, p.question, p.username, p.created_at AS "createdAt",
    COALESCE(
      json_agg(
        json_build_object('id', o.id, 'label', o.label, 'votes', COALESCE(v.cnt, 0))
        ORDER BY o.position, o.id
      ) FILTER (WHERE o.id IS NOT NULL),
      '[]'
    ) AS options,
    COALESCE(SUM(v.cnt), 0)::int AS total
  FROM polls p
  LEFT JOIN poll_options o ON o.poll_id = p.id
  LEFT JOIN (
    SELECT option_id, COUNT(*) AS cnt FROM poll_votes GROUP BY option_id
  ) v ON v.option_id = o.id
`;

function shapePoll(row, myOptionId) {
  return {
    id: row.id,
    question: row.question,
    username: row.username,
    createdAt: row.createdAt,
    total: row.total,
    myOptionId: myOptionId || null,
    options: (row.options || []).map((o) => ({
      id: o.id, label: o.label, votes: Number(o.votes),
    })),
  };
}

async function fetchPoll(pollId, user) {
  const { rows } = await pool.query(POLL_SELECT + `
    WHERE p.id = $1 GROUP BY p.id
  `, [pollId]);
  if (!rows.length) return null;
  let myOptionId = null;
  if (user) {
    const mine = await pool.query(
      'SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2',
      [pollId, user.id]
    );
    if (mine.rows.length) myOptionId = mine.rows[0].option_id;
  }
  return shapePoll(rows[0], myOptionId);
}

// Poll list, newest first, with the caller's own vote per poll so cards can
// show a "Voted" chip.
app.get('/api/polls', async (req, res) => {
  try {
    const { rows } = await pool.query(POLL_SELECT + `
      GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC
    `);
    let mine = new Map();
    if (req.user) {
      const myVotes = await pool.query(
        'SELECT poll_id, option_id FROM poll_votes WHERE user_id = $1',
        [req.user.id]
      );
      mine = new Map(myVotes.rows.map((r) => [r.poll_id, r.option_id]));
    }
    res.json({ polls: rows.map((r) => shapePoll(r, mine.get(r.id))) });
  } catch (err) {
    console.error('GET /api/polls failed', err.message);
    res.status(500).json({ error: 'Could not load polls' });
  }
});

app.get('/api/polls/:id', async (req, res) => {
  const pollId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
  if (!pollId) return res.status(404).json({ error: 'Poll not found' });
  try {
    const poll = await fetchPoll(pollId, req.user);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    res.json({ poll });
  } catch (err) {
    console.error('GET /api/polls/:id failed', err.message);
    res.status(500).json({ error: 'Could not load the poll' });
  }
});

// Create a poll: question of at least 3 characters, 2-4 non-empty options.
app.post('/api/polls', async (req, res) => {
  const body = req.body || {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const rawOptions = Array.isArray(body.options) ? body.options : [];
  const options = rawOptions
    .map((o) => (typeof o === 'string' ? o.trim() : ''))
    .filter(Boolean);
  if (question.length < 3) {
    return res.status(400).json({ error: 'Question needs at least 3 characters.' });
  }
  if (question.length > 280) {
    return res.status(400).json({ error: 'Question is limited to 280 characters.' });
  }
  if (options.length < 2 || options.length > 4) {
    return res.status(400).json({ error: 'A poll needs between 2 and 4 options.' });
  }
  if (options.some((o) => o.length > 120)) {
    return res.status(400).json({ error: 'Each option is limited to 120 characters.' });
  }
  try {
    const inserted = await pool.query(
      'INSERT INTO polls (question, user_id, username) VALUES ($1, $2, $3) RETURNING id',
      [question, req.user.id, req.user.username]
    );
    const pollId = inserted.rows[0].id;
    await pool.query(
      'INSERT INTO poll_options (poll_id, label, position) SELECT $1, x.label, x.position FROM unnest($2::text[], $3::int[]) AS x(label, position)',
      [pollId, options, options.map((_, i) => i)]
    );
    const poll = await fetchPoll(pollId, req.user);
    res.status(201).json({ poll });
  } catch (err) {
    console.error('POST /api/polls failed', err.message);
    res.status(500).json({ error: 'Could not create the poll' });
  }
});

// One-tap vote. One vote per user per poll (UNIQUE constraint); voting again
// answers 409 with the current results rather than changing the vote.
app.post('/api/polls/:id/vote', async (req, res) => {
  const pollId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
  const optionId = Number(req.body && req.body.optionId);
  if (!pollId) return res.status(404).json({ error: 'Poll not found' });
  if (!Number.isInteger(optionId)) {
    return res.status(400).json({ error: 'Pick an option to vote.' });
  }
  try {
    const pollRow = await pool.query('SELECT id FROM polls WHERE id = $1', [pollId]);
    if (!pollRow.rowCount) return res.status(404).json({ error: 'Poll not found' });
    const option = await pool.query(
      'SELECT id FROM poll_options WHERE id = $1 AND poll_id = $2',
      [optionId, pollId]
    );
    if (!option.rowCount) {
      return res.status(400).json({ error: 'That option is not on this poll.' });
    }
    const vote = await pool.query(`
      INSERT INTO poll_votes (poll_id, option_id, user_id, username)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (poll_id, user_id) DO NOTHING
      RETURNING id
    `, [pollId, optionId, req.user.id, req.user.username]);
    if (!vote.rowCount) {
      return res.status(409).json({ error: 'You already voted on this poll.' });
    }
    const poll = await fetchPoll(pollId, req.user);
    res.json({ poll });
  } catch (err) {
    console.error('POST /api/polls/:id/vote failed', err.message);
    res.status(500).json({ error: 'Could not record the vote' });
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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/poll-kilat-12dfb0/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/poll-kilat-12dfb0/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Malformed JSON bodies and unexpected errors answer as JSON, not an HTML
// express default page.
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  console.error('unhandled error', err);
  res.status(500).json({ error: 'Something went wrong' });
});

const DRAIN_MS = 3000;
let shuttingDown = false;
let server;

async function shutdown(signal) {
  if (shuttingDown) return; // idempotent: SIGTERM then SIGINT must not double-run
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  server.close(() => {});
  server.closeIdleConnections?.();
  const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate();
  await seedStaging();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });