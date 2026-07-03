#!/usr/bin/env node
// Failover / replication probe for the haload app. No dependencies (Node 18+).
//
//   node probe.mjs <write-url> [options]
//
// It drives CONCURRENT writers at the write endpoint (the leader, usually via the
// load balancer), recording the server-assigned monotonic `seq` of every
// acknowledged write. It measures three things:
//
//   • RTO  — downtime per outage (gap between the last good write and the first
//            good write after the standby is promoted).
//   • RPO  — EXACT data loss: on each recovery (and at the end) it calls
//            POST /api/verify with the full set of acked seqs and reports how many
//            acknowledged writes did NOT survive on the new leader. Expect 0.
//   • SYNC — replication speed, two ways:
//              (native)  pg_stat_replication replay_lag sampled from the leader.
//              (e2e)     with --nodes A,B: write on the leader, then poll the
//                        standby's replayed LSN until it passes the write's LSN,
//                        timed from THIS process's clock (no cross-host skew).
//
// Ctrl-C prints the summary.
//
// Options:
//   --conc N       concurrent writers (default 8)
//   --rate R       target total writes/sec (default: unthrottled)
//   --nodes A,B    direct node base URLs, comma-separated, for end-to-end sync
//                  lag (e.g. http://<ipA>:8080,http://<ipB>:8080)
//   --kind K       write kind: mixed|insert|kv|counter|ledger|doc|batch|patch|del (default mixed)
//   --csv FILE     per-second CSV (default failover-probe.csv)
//   --duration S   stop after S seconds (default: until Ctrl-C)

import { appendFileSync, writeFileSync } from 'node:fs';

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const BASE = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
function opt(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const CONC = Number(opt('conc', '8'));
const RATE = opt('rate', null) ? Number(opt('rate', null)) : null;
const KIND = opt('kind', 'mixed');
const CSV = opt('csv', 'failover-probe.csv');
const DURATION = opt('duration', null) ? Number(opt('duration', null)) : null;
const NODES = opt('nodes', null) ? opt('nodes', null).split(',').map((s) => s.trim().replace(/\/$/, '')) : [];
const TIMEOUT_MS = 5000;
const OUTAGE_MS = 2000;         // gap between successes that counts as an outage
const CLIENT_ID = 'probe-' + Math.floor(Date.now() / 1000).toString(36) + '-' + process.pid;

if (!BASE) {
  console.error('usage: node probe.mjs <write-url> [--conc N] [--rate R] [--nodes A,B] [--kind K] [--csv f] [--duration S]');
  process.exit(1);
}

// ---- state -----------------------------------------------------------------
const acked = [];               // server seqs of every acknowledged write
let clientSeq = 0;
let successes = 0, failures = 0;
const byKind = {};
let lastOkWall = Date.now();
const outages = [];             // { downIso, upIso, rtoMs, ackedBefore, lost, lostSample, promotedTo }
const nativeLag = [];           // replica replay_lag seconds sampled from the leader
const e2e = [];                 // end-to-end ms: write on leader -> visible on standby
let winOk = 0, winFail = 0;     // per-tick window counters
let running = true;

const lsnToBig = (s) => { if (!s || !s.includes('/')) return 0n; const [a, b] = s.split('/'); return (BigInt('0x' + a) << 32n) | BigInt('0x' + b); };
const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };
const isoNow = () => new Date().toISOString();

async function req(method, url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const opts = { method, signal: ctrl.signal, headers: { 'connection': 'keep-alive' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let b = null; try { b = await res.json(); } catch {}
    return { http: res.status, ok: res.ok, body: b, ms: Date.now() - t0 };
  } catch (e) {
    return { http: 0, ok: false, body: null, ms: Date.now() - t0, err: String(e.name || e) };
  } finally { clearTimeout(t); }
}

// ---- exact RPO check: verify all acked seqs survived on the current leader --
async function verify(seqs) {
  let present = 0, missing = 0; const sample = [];
  for (let i = 0; i < seqs.length; i += 5000) {
    const chunk = seqs.slice(i, i + 5000);
    const r = await req('POST', BASE + '/api/verify', { seqs: chunk });
    if (!r.ok || !r.body) { missing += chunk.length; continue; }   // count unknown as missing
    present += r.body.present; missing += r.body.missing_count;
    if (sample.length < 20 && Array.isArray(r.body.missing)) sample.push(...r.body.missing.slice(0, 20 - sample.length));
  }
  return { present, missing, sample };
}

async function whoLeads() {
  const st = await req('GET', BASE + '/api/status');
  return st.body && st.body.node ? st.body.node : '?';
}

// ---- one writer loop -------------------------------------------------------
async function worker() {
  const perWriteMs = RATE ? (1000 * CONC) / RATE : 0;
  while (running) {
    const t0 = Date.now();
    const r = await req('POST', BASE + '/api/write', { kind: KIND, client_id: CLIENT_ID, client_seq: ++clientSeq });
    const now = Date.now();
    if (r.http === 201 && r.body && r.body.seq != null) {
      successes++; winOk++;
      acked.push(r.body.seq);
      byKind[r.body.kind] = (byKind[r.body.kind] || 0) + 1;
      const gap = now - lastOkWall;
      if (gap > OUTAGE_MS) await closeOutage(now, gap);   // an outage just ended
      lastOkWall = now;
    } else {
      failures++; winFail++;
    }
    if (perWriteMs) { const wait = perWriteMs - (Date.now() - t0); if (wait > 0) await sleep(wait); }
  }
}

async function closeOutage(nowWall, gapMs) {
  const ackedBefore = acked.length;
  process.stdout.write(`\n  ── recovery after ${(gapMs / 1000).toFixed(1)}s down — verifying ${ackedBefore} acked writes…\n`);
  const v = await verify(acked.slice());
  const promotedTo = await whoLeads();
  const rec = { downIso: new Date(lastOkWall).toISOString(), upIso: new Date(nowWall).toISOString(),
    rtoMs: gapMs, ackedBefore, lost: v.missing, lostSample: v.sample, promotedTo };
  outages.push(rec);
  console.log(`  ── RTO ${(gapMs / 1000).toFixed(1)}s · RPO ${v.missing === 0 ? 'OK (0 lost of ' + ackedBefore + ')' : 'LOSS ' + v.missing + ' of ' + ackedBefore} · now served by ${promotedTo}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- sync-lag sampler: native (leader pg_stat_replication) -----------------
async function nativeSampler() {
  while (running) {
    const st = await req('GET', BASE + '/api/status');
    const rep = st.body && st.body.replication;
    if (rep && rep.role === 'leader' && Array.isArray(rep.replicas) && rep.replicas.length) {
      const l = rep.replicas[0].replay_lag_s;
      if (l != null) nativeLag.push(Number(l));
    }
    await sleep(1000);
  }
}

// ---- sync-lag sampler: end-to-end (write on leader -> readable on standby) --
let standbyUrl = null, lastRoleCheck = 0;
async function refreshStandby() {
  for (const u of NODES) {
    const st = await req('GET', u + '/api/status');
    if (st.body && st.body.role === 'replica') { standbyUrl = u; return; }
  }
  standbyUrl = null;
}
async function e2eSampler() {
  if (NODES.length < 2) return;
  while (running) {
    if (Date.now() - lastRoleCheck > 5000) { await refreshStandby(); lastRoleCheck = Date.now(); }
    if (!standbyUrl) { await sleep(1000); continue; }
    const w = await req('POST', BASE + '/api/write', { kind: 'insert', client_id: CLIENT_ID, client_seq: ++clientSeq });
    const t0 = Date.now();
    if (w.http === 201 && w.body && w.body.lsn) {
      successes++; winOk++; acked.push(w.body.seq); byKind[w.body.kind] = (byKind[w.body.kind] || 0) + 1;
      const target = lsnToBig(w.body.lsn);
      let done = false;
      while (Date.now() - t0 < 15000 && running) {
        const s = await req('GET', standbyUrl + '/api/lsn');
        if (s.body && s.body.lsn && lsnToBig(s.body.lsn) >= target) { e2e.push(Date.now() - t0); done = true; break; }
        await sleep(40);
      }
      if (!done) { /* standby did not catch up in window (likely mid-failover) */ }
    }
    await sleep(1000);
  }
}

// ---- per-second aggregator + CSV -------------------------------------------
writeFileSync(CSV, 'iso,ok,fail,wps,acked_total,native_lag_s,e2e_lag_ms,down\n');
function tick() {
  const down = winOk === 0 && winFail > 0 ? 1 : 0;
  const nl = nativeLag.length ? nativeLag[nativeLag.length - 1] : '';
  const el = e2e.length ? e2e[e2e.length - 1] : '';
  appendFileSync(CSV, `${isoNow()},${winOk},${winFail},${winOk},${acked.length},${nl},${el},${down}\n`);
  process.stdout.write(`${new Date().toLocaleTimeString()}  ok=${winOk} fail=${winFail}  acked=${acked.length}` +
    `  nativeLag=${nl === '' ? '–' : Number(nl).toFixed(2) + 's'}  e2e=${el === '' ? '–' : el + 'ms'}${down ? '  DOWN' : ''}\n`);
  winOk = 0; winFail = 0;
}

async function summary() {
  running = false;
  await sleep(200);
  console.log('\n================ SUMMARY ================');
  console.log(`target ${BASE}  ·  client ${CLIENT_ID}  ·  conc ${CONC}${RATE ? ' rate ' + RATE + '/s' : ' (unthrottled)'}`);
  console.log(`writes: ${successes} ok / ${failures} failed  ·  acked seqs recorded: ${acked.length}`);
  console.log('by kind: ' + (Object.keys(byKind).length ? Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  ') : '—'));

  // Final full RPO check.
  if (acked.length) {
    const v = await verify(acked.slice());
    console.log(`\nFINAL RPO: ${v.missing === 0 ? 'OK — all ' + acked.length + ' acknowledged writes present (0 lost)' :
      'LOSS — ' + v.missing + ' of ' + acked.length + ' acknowledged writes MISSING  e.g. ' + v.sample.join(',')}`);
  }
  if (!outages.length) console.log('\nno outage observed.');
  else {
    console.log('');
    outages.forEach((o, i) => console.log(
      `outage #${i + 1}: ${o.downIso} → ${o.upIso}  RTO=${(o.rtoMs / 1000).toFixed(1)}s  ` +
      `RPO=${o.lost === 0 ? '0 (no acked write lost)' : 'LOSS ' + o.lost + ' e.g. ' + o.lostSample.join(',')}  promoted→${o.promotedTo}`));
    console.log(`worst RTO: ${(Math.max(...outages.map((o) => o.rtoMs)) / 1000).toFixed(1)}s`);
  }

  console.log('\nSYNC SPEED:');
  if (nativeLag.length) console.log(`  native replay_lag (leader view): p50 ${fmt(pct(nativeLag, 50))}s  p95 ${fmt(pct(nativeLag, 95))}s  max ${fmt(Math.max(...nativeLag))}s  (n=${nativeLag.length})`);
  else console.log('  native replay_lag: no samples (single-node / no streaming replica seen)');
  if (e2e.length) console.log(`  end-to-end (write→readable on standby): p50 ${e2e[0] != null ? pct(e2e, 50) : '–'}ms  p95 ${pct(e2e, 95)}ms  max ${Math.max(...e2e)}ms  (n=${e2e.length})`);
  else if (NODES.length >= 2) console.log('  end-to-end: no samples captured');
  else console.log('  end-to-end: disabled (pass --nodes A,B to enable)');
  console.log(`\ncsv: ${CSV}`);
  console.log('=========================================');
  process.exit(0);
}
const fmt = (x) => x == null ? '–' : Number(x).toFixed(2);

process.on('SIGINT', summary);
process.on('SIGTERM', summary);

console.log(`probing ${BASE}  ·  ${CONC} writers  ·  kind=${KIND}${RATE ? '  rate=' + RATE + '/s' : ''}` +
  `${NODES.length >= 2 ? '  e2e-nodes=' + NODES.join(',') : ''}  — Ctrl-C for summary`);

for (let i = 0; i < CONC; i++) worker();
nativeSampler();
e2eSampler();
const ticker = setInterval(tick, 1000);
if (DURATION) setTimeout(() => { clearInterval(ticker); summary(); }, DURATION * 1000);
