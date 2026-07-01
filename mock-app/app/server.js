// CRUD to-do app for cross-region failover + replication testing.
//
// Every app server runs this against its OWN local Postgres. On the Region A
// server that Postgres is the Patroni leader (writable); on the Region B twin
// it's a synchronous standby (read-only) until failover promotes it.
//
//   Writes (POST/PATCH/DELETE) only succeed on the leader -> a standby is
//   visibly read-only, and once promoted it starts accepting writes.
//   Reads (GET) work everywhere -> open the Region B URL and watch the rows you
//   created on A appear, proving replication + showing the lag.
//
// UI at "/" shows: which node/region is serving, LEADER vs REPLICA, replication
// lag, and the live to-do list.
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const {
  PGHOST = 'host.docker.internal',
  PGPORT = '5432',
  PGUSER = 'postgres',
  PGPASSWORD = 'postgres',
  PGDATABASE = 'postgres',
  REDIS_URL = 'redis://redis:6379',
  REGION = 'unknown',
  NODE_NAME = 'unknown',
  PORT = '8080',
} = process.env;

const pool = new Pool({
  host: PGHOST, port: Number(PGPORT), user: PGUSER, password: PGPASSWORD,
  database: PGDATABASE, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
});
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
redis.connect().catch(() => {});

async function inRecovery() {
  const { rows } = await pool.query('SELECT pg_is_in_recovery() AS r');
  return rows[0].r === true;
}
async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS todos (
    id          bigserial PRIMARY KEY,
    title       text NOT NULL,
    done        boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    origin_node text
  )`);
}
function readOnly(res) {
  return res.status(503).json({ ok: false, error: 'read-only standby', node: NODE_NAME, region: REGION });
}

async function replicationStatus(recovering) {
  try {
    if (recovering) {
      const { rows } = await pool.query(`SELECT
        pg_last_wal_receive_lsn()::text AS receive_lsn,
        pg_last_wal_replay_lsn()::text  AS replay_lsn,
        EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float AS lag_seconds`);
      return { role: 'replica', lag_seconds: rows[0].lag_seconds, receive_lsn: rows[0].receive_lsn, replay_lsn: rows[0].replay_lsn };
    }
    const { rows } = await pool.query(`SELECT client_addr::text AS client_addr, state, sync_state,
      EXTRACT(EPOCH FROM replay_lag)::float AS replay_lag_seconds
      FROM pg_stat_replication`);
    return { role: 'leader', replicas: rows };
  } catch (e) {
    return { role: recovering ? 'replica' : 'leader', error: String(e.message || e) };
  }
}

const app = express();
app.use(express.json());

// Route 53 / GSLB health probe: 200 only when writable (the leader).
app.get('/health', async (_req, res) => {
  try {
    if (await inRecovery()) return res.status(503).json({ ok: false, writable: false, node: NODE_NAME, region: REGION });
    await ensureSchema();
    res.json({ ok: true, writable: true, node: NODE_NAME, region: REGION });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e.message || e), node: NODE_NAME, region: REGION });
  }
});

app.get('/api/status', async (_req, res) => {
  try {
    const rec = await inRecovery();
    const { rows } = await pool.query('SELECT count(*)::int AS n, max(updated_at) AS last FROM todos');
    let redisOk = false;
    try { redisOk = (await redis.ping()) === 'PONG'; } catch {}
    res.json({
      node: NODE_NAME, region: REGION, role: rec ? 'replica' : 'leader', writable: !rec,
      todo_count: rows[0].n, last_change: rows[0].last, redis_ok: redisOk,
      replication: await replicationStatus(rec),
    });
  } catch (e) {
    res.status(503).json({ node: NODE_NAME, region: REGION, error: String(e.message || e) });
  }
});

app.get('/api/todos', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title, done, created_at, updated_at, origin_node FROM todos ORDER BY id DESC LIMIT 200');
    res.json(rows);
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});
app.post('/api/todos', async (req, res) => {
  const title = ((req.body && req.body.title) || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    if (await inRecovery()) return readOnly(res);
    await ensureSchema();
    const { rows } = await pool.query(
      'INSERT INTO todos(title, origin_node) VALUES ($1,$2) RETURNING id, title, done, created_at, updated_at, origin_node',
      [title, NODE_NAME]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});
app.patch('/api/todos/:id', async (req, res) => {
  try {
    if (await inRecovery()) return readOnly(res);
    const { rows } = await pool.query(
      `UPDATE todos SET title = COALESCE($2, title), done = COALESCE($3, done), updated_at = now()
       WHERE id = $1 RETURNING id, title, done, created_at, updated_at, origin_node`,
      [req.params.id, req.body.title ?? null, typeof req.body.done === 'boolean' ? req.body.done : null]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});
app.delete('/api/todos/:id', async (req, res) => {
  try {
    if (await inRecovery()) return readOnly(res);
    const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1', [req.params.id]);
    res.json({ deleted: rowCount });
  } catch (e) { res.status(503).json({ error: String(e.message || e) }); }
});

app.get('/', (_req, res) => res.type('html').send(HTML));

app.listen(Number(PORT), () => console.log(`todo app on :${PORT} (node=${NODE_NAME} region=${REGION})`));

// minimal single-page UI (no build step, no external assets)
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HA To-Do</title><style>
 body{font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px}
 #bar{padding:12px 16px;border-radius:8px;color:#fff;font-weight:600}
 .leader{background:#2b8a3e}.replica{background:#e67700}.down{background:#c92a2a}
 #bar small{display:block;font-weight:400;opacity:.9;margin-top:4px}
 form{display:flex;gap:8px;margin:16px 0}input[type=text]{flex:1;padding:8px}
 button{padding:8px 12px;cursor:pointer}
 li{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee}
 li.done span{text-decoration:line-through;color:#999}li span{flex:1}
 .tag{font-size:11px;color:#999}
</style></head><body>
<h2>HA To-Do</h2>
<div id="bar" class="down">connecting…</div>
<form id="add"><input type="text" id="title" placeholder="New task…" autocomplete="off"><button>Add</button></form>
<ul id="list"></ul>
<script>
 var readOnly=false;
 function j(u,o){return fetch(u,o).then(function(r){return r.json().then(function(b){return{s:r.status,b:b}})})}
 function status(){j('/api/status').then(function(x){
   var b=x.b,bar=document.getElementById('bar');
   if(x.s>=500){bar.className='down';bar.textContent='DB unreachable on '+(b.node||'?');return}
   readOnly=(b.role==='replica');
   bar.className=readOnly?'replica':'leader';
   var rep=b.replication||{};
   var lag=(rep.lag_seconds!=null)?(' · replica lag '+Number(rep.lag_seconds).toFixed(1)+'s'):
           (rep.replicas?(' · '+rep.replicas.length+' replica(s) streaming'):'');
   bar.innerHTML=b.region+' — '+b.node+' — '+(readOnly?'REPLICA (read-only)':'LEADER (writable)')+
     '<small>'+b.todo_count+' todos'+lag+' · redis '+(b.redis_ok?'ok':'down')+'</small>';
   document.querySelector('#add button').disabled=readOnly;
   document.getElementById('title').placeholder=readOnly?'read-only standby — writes go to the leader':'New task…';
 }).catch(function(){})}
 function load(){j('/api/todos').then(function(x){
   if(!Array.isArray(x.b))return;
   var ul=document.getElementById('list');ul.innerHTML='';
   x.b.forEach(function(t){
     var li=document.createElement('li');if(t.done)li.className='done';
     var cb=document.createElement('input');cb.type='checkbox';cb.checked=t.done;cb.disabled=readOnly;
     cb.onchange=function(){j('/api/todos/'+t.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({done:cb.checked})}).then(load)};
     var s=document.createElement('span');s.textContent=t.title;
     var tag=document.createElement('span');tag.className='tag';tag.textContent='#'+t.id+' @'+(t.origin_node||'?');
     var del=document.createElement('button');del.textContent='✕';del.disabled=readOnly;
     del.onclick=function(){j('/api/todos/'+t.id,{method:'DELETE'}).then(load)};
     li.appendChild(cb);li.appendChild(s);li.appendChild(tag);li.appendChild(del);ul.appendChild(li);
   });
 }).catch(function(){})}
 document.getElementById('add').onsubmit=function(e){e.preventDefault();
   var i=document.getElementById('title');if(!i.value.trim())return;
   j('/api/todos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:i.value.trim()})}).then(function(){i.value='';load()})};
 status();load();setInterval(status,2000);setInterval(load,2000);
</script></body></html>`;
