// haload — a write-workload app for cross-region failover + replication testing.
//
// Every app server runs this against its OWN local Postgres. On the Region A
// server that Postgres is the Patroni leader (writable); on the Region B twin
// it is a synchronous standby (read-only) until failover promotes it. Writes
// only succeed on the leader; reads work everywhere.
//
// The point of this version (vs. the old single-table to-do app) is to make
// replication *provably* lossless and to measure how fast it syncs:
//
//   • Many write patterns (insert / upsert / hot-row counter / transactional
//     ledger / big JSONB doc / bulk batch / update / delete) exercise a broad
//     mix of WAL records and locking.
//   • EVERY successful write, whatever its pattern, inserts one row into a single
//     append-only ledger table `writes` IN THE SAME TRANSACTION, and returns its
//     server-assigned monotonic `seq` + the post-commit WAL LSN. `seq` is the
//     durability token: a client records every acked `seq`, and after a failover
//     asks the new leader (POST /api/verify) which survived. RPO = acked-but-
//     missing count — exact, not "highest id survived".
//   • /api/lsn exposes this node's WAL position (leader: current; replica:
//     replayed) so a client can time exactly when a write became durable on the
//     standby (end-to-end sync lag). /api/status also exposes Postgres-native
//     replication lag (write/flush/replay) from the leader.
const express = require('express');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const {
  PGHOST = 'host.docker.internal',
  PGPORT = '5432',
  PGUSER = 'postgres',
  PGPASSWORD = 'postgres',
  PGDATABASE = 'postgres',
  REGION = 'unknown',
  NODE_NAME = 'unknown',
  PORT = '8080',
} = process.env;

const pool = new Pool({
  host: PGHOST, port: Number(PGPORT), user: PGUSER, password: PGPASSWORD,
  database: PGDATABASE, max: 12, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
});

// ---------------------------------------------------------------------------
// Schema — created on the leader (a standby is read-only and receives it via
// replication). `writes` is the unified durability ledger every pattern feeds.
// ---------------------------------------------------------------------------
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS writes (
      seq         bigserial PRIMARY KEY,
      client_id   text,
      client_seq  bigint,
      kind        text NOT NULL,
      payload     jsonb,
      wal_lsn     pg_lsn,
      origin_node text,
      created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE IF NOT EXISTS items (
      id bigserial PRIMARY KEY, label text, n int NOT NULL DEFAULT 0,
      done boolean NOT NULL DEFAULT false, origin_node text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kv (
      key text PRIMARY KEY, value jsonb, version int NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS counters (
      name text PRIMARY KEY, value bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id int PRIMARY KEY, balance bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id bigserial PRIMARY KEY, account int NOT NULL, delta bigint NOT NULL,
      balance bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS docs (
      id uuid PRIMARY KEY, body jsonb NOT NULL, size int,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  schemaReady = true;
}

async function inRecovery() {
  const { rows } = await pool.query('SELECT pg_is_in_recovery() AS r');
  return rows[0].r === true;
}
function readOnly(res) {
  return res.status(503).json({ ok: false, error: 'read-only standby', node: NODE_NAME, region: REGION });
}
const randInt = (n) => Math.floor(Math.random() * n);

// ---------------------------------------------------------------------------
// Core write path. Runs the pattern's own statements AND the ledger insert in
// ONE transaction, then reads the post-commit WAL LSN (>= this commit's LSN, so
// a standby that has replayed up to it definitely has this write). Returns the
// monotonic `seq` and that `lsn`.
// ---------------------------------------------------------------------------
async function doWrite(kind, clientId, clientSeq, patternFn) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payload = await patternFn(client);
    const { rows } = await client.query(
      `INSERT INTO writes (client_id, client_seq, kind, payload, wal_lsn, origin_node)
       VALUES ($1, $2, $3, $4, pg_current_wal_lsn(), $5) RETURNING seq`,
      [clientId ?? null, clientSeq ?? null, kind, payload ? JSON.stringify(payload) : null, NODE_NAME]);
    await client.query('COMMIT');
    const { rows: l } = await client.query('SELECT pg_current_wal_lsn()::text AS lsn');
    return { seq: Number(rows[0].seq), lsn: l[0].lsn, kind, payload };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- the write patterns (each returns a small payload describing what it did)
const patterns = {
  async insert(c) {
    const { rows } = await c.query(
      `INSERT INTO items (label, origin_node) VALUES ($1, $2) RETURNING id`,
      [`item-${randInt(1e9)}`, NODE_NAME]);
    return { item_id: Number(rows[0].id) };
  },
  async kv(c) {
    const key = `k${randInt(1000)}`;
    const { rows } = await c.query(
      `INSERT INTO kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
         version = kv.version + 1, updated_at = now() RETURNING version`,
      [key, JSON.stringify({ r: randInt(1e9), at: Date.now() })]);
    return { key, version: rows[0].version };
  },
  async counter(c, name) {
    const n = name || `c${randInt(16)}`;
    const { rows } = await c.query(
      `INSERT INTO counters (name, value) VALUES ($1, 1)
       ON CONFLICT (name) DO UPDATE SET value = counters.value + 1, updated_at = now()
       RETURNING value`, [n]);
    return { name: n, value: Number(rows[0].value) };
  },
  async ledger(c) {
    const account = randInt(8);
    const delta = randInt(2001) - 1000; // -1000..1000
    await c.query(`INSERT INTO accounts (id, balance) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING`, [account]);
    const { rows: a } = await c.query(`SELECT balance FROM accounts WHERE id = $1 FOR UPDATE`, [account]);
    const balance = Number(a[0].balance) + delta;
    await c.query(`INSERT INTO ledger (account, delta, balance) VALUES ($1, $2, $3)`, [account, delta, balance]);
    await c.query(`UPDATE accounts SET balance = $2 WHERE id = $1`, [account, balance]);
    return { account, delta, balance };
  },
  async doc(c) {
    const size = 8 + randInt(56); // 8..63 fields
    const body = { id: randInt(1e9), tags: Array.from({ length: size }, () => randUUIDish()) };
    const id = randomUUID();
    await c.query(`INSERT INTO docs (id, body, size) VALUES ($1, $2, $3)`, [id, JSON.stringify(body), size]);
    return { doc_id: id, size };
  },
  async batch(c, n) {
    const k = Math.min(Math.max(Number(n) || 10, 1), 100);
    const vals = [], params = [];
    for (let i = 0; i < k; i++) { params.push(`($${i * 2 + 1}, $${i * 2 + 2})`); vals.push(`batch-${randInt(1e9)}`, NODE_NAME); }
    await c.query(`INSERT INTO items (label, origin_node) VALUES ${params.join(',')}`, vals);
    return { batch_n: k };
  },
  async patch(c) {
    const { rows } = await c.query(
      `UPDATE items SET done = NOT done, n = n + 1, updated_at = now()
       WHERE id = (SELECT id FROM items ORDER BY random() LIMIT 1) RETURNING id`);
    return { item_id: rows.length ? Number(rows[0].id) : null, patched: rows.length };
  },
  async del(c) {
    const { rowCount } = await c.query(
      `DELETE FROM items WHERE id = (SELECT id FROM items ORDER BY random() LIMIT 1)`);
    return { deleted: rowCount };
  },
};
function randUUIDish() { return randomUUID().slice(0, 8); }

// Weighted random kind for the mixed workload.
const MIX = ['insert', 'insert', 'insert', 'kv', 'kv', 'counter', 'counter', 'ledger', 'ledger', 'doc', 'batch', 'patch', 'del'];
function pickKind() { return MIX[randInt(MIX.length)]; }

async function runKind(kind, body) {
  switch (kind) {
    case 'insert': return doWrite('insert', body.client_id, body.client_seq, patterns.insert);
    case 'kv': return doWrite('kv', body.client_id, body.client_seq, patterns.kv);
    case 'counter': return doWrite('counter', body.client_id, body.client_seq, (c) => patterns.counter(c, body.name));
    case 'ledger': return doWrite('ledger', body.client_id, body.client_seq, patterns.ledger);
    case 'doc': return doWrite('doc', body.client_id, body.client_seq, patterns.doc);
    case 'batch': return doWrite('batch', body.client_id, body.client_seq, (c) => patterns.batch(c, body.n));
    case 'patch': return doWrite('patch', body.client_id, body.client_seq, patterns.patch);
    case 'del': case 'delete': return doWrite('del', body.client_id, body.client_seq, patterns.del);
    default: throw new Error(`unknown kind: ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Replication reporting
// ---------------------------------------------------------------------------
async function replicationStatus(recovering) {
  try {
    if (recovering) {
      const { rows } = await pool.query(`SELECT
        pg_last_wal_receive_lsn()::text AS receive_lsn,
        pg_last_wal_replay_lsn()::text  AS replay_lsn,
        EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float AS lag_seconds`);
      return { role: 'replica', ...rows[0] };
    }
    const { rows } = await pool.query(`SELECT application_name, client_addr::text AS client_addr, state, sync_state,
      EXTRACT(EPOCH FROM write_lag)::float  AS write_lag_s,
      EXTRACT(EPOCH FROM flush_lag)::float  AS flush_lag_s,
      EXTRACT(EPOCH FROM replay_lag)::float AS replay_lag_s
      FROM pg_stat_replication`);
    return { role: 'leader', replicas: rows };
  } catch (e) {
    return { role: recovering ? 'replica' : 'leader', error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));

// GSLB health probe: 200 only when writable (the leader).
app.get('/health', async (_req, res) => {
  try {
    if (await inRecovery()) return res.status(503).json({ ok: false, writable: false, node: NODE_NAME, region: REGION });
    await ensureSchema();
    res.json({ ok: true, writable: true, node: NODE_NAME, region: REGION });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e.message || e), node: NODE_NAME, region: REGION });
  }
});

// This node's WAL position — leader: current write LSN; replica: replayed LSN.
// A client polls the standby's replay lsn to time when a write became durable.
app.get('/api/lsn', async (_req, res) => {
  try {
    const rec = await inRecovery();
    const q = rec ? 'SELECT pg_last_wal_replay_lsn()::text AS lsn' : 'SELECT pg_current_wal_lsn()::text AS lsn';
    const { rows } = await pool.query(q);
    res.json({ node: NODE_NAME, region: REGION, role: rec ? 'replica' : 'leader', lsn: rows[0].lsn, ts: Date.now() });
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});

app.get('/api/status', async (_req, res) => {
  try {
    const rec = await inRecovery();
    let counts = {}, maxSeq = null;
    try {
      const { rows } = await pool.query(`SELECT
        (SELECT count(*) FROM writes)::bigint   AS writes,
        (SELECT max(seq) FROM writes)::bigint    AS max_seq,
        (SELECT count(*) FROM items)::bigint      AS items,
        (SELECT count(*) FROM kv)::bigint         AS kv,
        (SELECT count(*) FROM counters)::bigint   AS counters,
        (SELECT count(*) FROM ledger)::bigint     AS ledger,
        (SELECT count(*) FROM docs)::bigint       AS docs`);
      const r = rows[0];
      maxSeq = r.max_seq == null ? 0 : Number(r.max_seq);
      counts = { writes: Number(r.writes), items: Number(r.items), kv: Number(r.kv),
        counters: Number(r.counters), ledger: Number(r.ledger), docs: Number(r.docs) };
    } catch { /* tables may not exist yet on a fresh standby */ }
    res.json({
      node: NODE_NAME, region: REGION, role: rec ? 'replica' : 'leader', writable: !rec,
      max_seq: maxSeq, counts, replication: await replicationStatus(rec),
    });
  } catch (e) {
    res.status(503).json({ node: NODE_NAME, region: REGION, error: String(e.message || e) });
  }
});

// Exact RPO check: which of these acked seqs survived on this (new) leader?
app.post('/api/verify', async (req, res) => {
  const seqs = Array.isArray(req.body && req.body.seqs) ? req.body.seqs.map(Number).filter(Number.isFinite) : null;
  if (!seqs) return res.status(400).json({ error: 'body { seqs: [..] } required' });
  try {
    const { rows } = await pool.query(`SELECT seq FROM writes WHERE seq = ANY($1::bigint[])`, [seqs]);
    const present = new Set(rows.map((r) => Number(r.seq)));
    const missing = seqs.filter((s) => !present.has(s));
    const { rows: mx } = await pool.query('SELECT COALESCE(max(seq),0)::bigint AS m FROM writes');
    res.json({ checked: seqs.length, present: present.size, missing_count: missing.length,
      missing: missing.slice(0, 200), max_seq: Number(mx[0].m), node: NODE_NAME });
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});

// Unified write endpoint the probe hammers. body: { kind?, client_id, client_seq, n?, name? }
app.post('/api/write', async (req, res) => {
  const body = req.body || {};
  const kind = body.kind && body.kind !== 'mixed' ? body.kind : pickKind();
  try {
    if (await inRecovery()) return readOnly(res);
    const r = await runKind(kind, body);
    res.status(201).json(r);
  } catch (e) { res.status(503).json({ error: String(e.message || e), kind }); }
});

// Individual write endpoints (handy for the UI / manual testing / demos).
const writeRoute = (kind) => async (req, res) => {
  try {
    if (await inRecovery()) return readOnly(res);
    const body = { ...req.body, ...(req.params || {}) };
    res.status(201).json(await runKind(kind, body));
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
};
app.post('/api/insert', writeRoute('insert'));
app.post('/api/kv', writeRoute('kv'));
app.post('/api/counter/:name', writeRoute('counter'));
app.post('/api/ledger', writeRoute('ledger'));
app.post('/api/doc', writeRoute('doc'));
app.post('/api/batch', writeRoute('batch'));
app.patch('/api/row/:id', writeRoute('patch'));
app.delete('/api/row/:id', writeRoute('del'));

// Recent writes, for the dashboard.
app.get('/api/feed', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT seq, kind, origin_node, created_at FROM writes ORDER BY seq DESC LIMIT 40`);
    res.json(rows);
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});

app.get('/', (_req, res) => res.type('html').send(HTML));

// Try to create the schema at boot (succeeds once this node is the leader).
(async function initLoop() {
  for (let i = 0; i < 1e9; i++) {
    try { if (!(await inRecovery())) { await ensureSchema(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
})();

app.listen(Number(PORT), () => console.log(`haload on :${PORT} (node=${NODE_NAME} region=${REGION})`));

// ---------------------------------------------------------------------------
// Dashboard (single page, no build step, no external assets)
// ---------------------------------------------------------------------------
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>haload — HA write tester</title><style>
 body{font-family:system-ui,sans-serif;max-width:820px;margin:20px auto;padding:0 16px;color:#222}
 #bar{padding:12px 16px;border-radius:8px;color:#fff;font-weight:600}
 .leader{background:#2b8a3e}.replica{background:#e67700}.down{background:#c92a2a}
 #bar small{display:block;font-weight:400;opacity:.92;margin-top:4px}
 .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:14px 0}
 .cell{background:#f1f3f5;border-radius:6px;padding:8px;text-align:center}
 .cell b{display:block;font-size:18px}.cell span{font-size:11px;color:#666}
 .btns{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
 button{padding:7px 10px;cursor:pointer;border:1px solid #ccc;border-radius:6px;background:#fff}
 button.hot{background:#1971c2;color:#fff;border-color:#1971c2}
 table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:4px 6px;border-bottom:1px solid #eee;text-align:left}
 .k{font-family:ui-monospace,monospace}
</style></head><body>
<h2>haload — cross-region write tester</h2>
<div id="bar" class="down">connecting…</div>
<div class="grid" id="counts"></div>
<div class="btns">
 <button data-k="insert">insert</button><button data-k="kv">upsert</button>
 <button data-k="counter">counter</button><button data-k="ledger">ledger</button>
 <button data-k="doc">doc</button><button data-k="batch">batch</button>
 <button data-k="patch">patch</button><button data-k="del">delete</button>
 <button id="hammer" class="hot">▶ hammer mixed</button>
</div>
<table><thead><tr><th>seq</th><th>kind</th><th>node</th><th>when</th></tr></thead><tbody id="feed"></tbody></table>
<script>
 var ro=false,hammer=false;
 function j(u,o){return fetch(u,o).then(function(r){return r.json().then(function(b){return{s:r.status,b:b}}).catch(function(){return{s:r.status,b:null}})})}
 function status(){j('/api/status').then(function(x){
   var b=x.b||{},bar=document.getElementById('bar');
   if(x.s>=500||!b.role){bar.className='down';bar.textContent='DB unreachable';return}
   ro=(b.role==='replica');bar.className=ro?'replica':'leader';
   var rep=b.replication||{},lag='';
   if(rep.role==='replica'&&rep.lag_seconds!=null)lag=' · replica replay lag '+Number(rep.lag_seconds).toFixed(2)+'s';
   else if(rep.replicas)lag=' · '+rep.replicas.length+' replica(s): '+rep.replicas.map(function(r){return (r.sync_state||'')+' replay '+(r.replay_lag_s!=null?Number(r.replay_lag_s).toFixed(2)+'s':'~0')}).join(', ');
   bar.innerHTML=b.region+' — '+b.node+' — '+(ro?'REPLICA (read-only)':'LEADER (writable)')+
     '<small>max seq '+b.max_seq+lag+'</small>';
   var c=b.counts||{},g=document.getElementById('counts');g.innerHTML='';
   [['writes','writes'],['items','items'],['kv','kv'],['counters','counters'],['ledger','ledger'],['docs','docs']].forEach(function(p){
     var d=document.createElement('div');d.className='cell';d.innerHTML='<b>'+(c[p[0]]!=null?c[p[0]]:'–')+'</b><span>'+p[1]+'</span>';g.appendChild(d);});
   document.querySelectorAll('.btns button[data-k]').forEach(function(x){x.disabled=ro});
 }).catch(function(){})}
 function feed(){j('/api/feed').then(function(x){
   if(!Array.isArray(x.b))return;var t=document.getElementById('feed');t.innerHTML='';
   x.b.forEach(function(w){var tr=document.createElement('tr');
     tr.innerHTML='<td class=k>'+w.seq+'</td><td>'+w.kind+'</td><td>'+(w.origin_node||'')+'</td><td>'+new Date(w.created_at).toLocaleTimeString()+'</td>';t.appendChild(tr);});
 }).catch(function(){})}
 function write(k){return j('/api/write',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:k})})}
 document.querySelectorAll('.btns button[data-k]').forEach(function(x){x.onclick=function(){write(x.getAttribute('data-k')).then(feed)}});
 document.getElementById('hammer').onclick=function(){hammer=!hammer;this.textContent=hammer?'⏸ stop':'▶ hammer mixed';};
 (function loop(){if(hammer&&!ro){write('mixed');}setTimeout(loop,120)})();
 status();feed();setInterval(status,1500);setInterval(feed,1500);
</script></body></html>`;
