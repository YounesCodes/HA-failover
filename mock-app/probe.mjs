#!/usr/bin/env node
// Failover probe: creates a todo (POST /api/todos) each tick, logs every result
// to CSV, and on each outage→recovery computes RTO (downtime) and an RPO verdict
// (did every acknowledged todo survive the failover?). No dependencies — Node 18+.
//
//   node probe.mjs http://app1-ip:8080 [intervalMs] [out.csv]
//
// Ctrl-C prints the summary.

const BASE = process.argv[2];
const INTERVAL = Number(process.argv[3] || 1000);
const CSV = process.argv[4] || 'failover-probe.csv';
const TIMEOUT_MS = 4000;

if (!BASE) {
  console.error('usage: node probe.mjs <base-url> [intervalMs] [out.csv]');
  process.exit(1);
}

import { appendFileSync, writeFileSync } from 'node:fs';

writeFileSync(CSV, 'seq,iso,ok,http,latency_ms,id,node,region,note\n');

let seq = 0;
let prevSuccess = false;
let lastSuccessWall = null; // ms epoch of the last good beat
let maxAckedId = 0; // highest id we got a 200 ack for
let outage = null; // { startWall, lastSuccessWall, ackedBefore }
const outages = []; // closed outages with rto/rpo
let successes = 0;
let failures = 0;

const isoNow = () => new Date().toISOString();
const csvRow = (r) =>
  appendFileSync(
    CSV,
    `${r.seq},${r.iso},${r.ok},${r.http},${r.latency},${r.id ?? ''},${r.node ?? ''},${r.region ?? ''},${r.note ?? ''}\n`,
  );

async function fetchJson(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const opts = { method, signal: ctrl.signal };
    if (body !== undefined) { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const latency = Date.now() - t0;
    let body = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return { http: res.status, ok: res.ok, body, latency };
  } catch (e) {
    return { http: 0, ok: false, body: null, latency: Date.now() - t0, error: String(e.name || e) };
  } finally {
    clearTimeout(t);
  }
}

async function closeOutage(nowWall) {
  // RTO: gap between the last good beat and the first good beat after recovery.
  const rtoMs = nowWall - outage.lastSuccessWall;
  // RPO: every acknowledged todo before the outage must still be present.
  const todos = await fetchJson('GET', '/api/todos');
  const st = await fetchJson('GET', '/api/status');
  const postMaxId = Array.isArray(todos.body) && todos.body.length ? todos.body[0].id : null;
  const survived = postMaxId !== null && postMaxId >= outage.ackedBefore;
  const rec = {
    downIso: new Date(outage.startWall).toISOString(),
    upIso: new Date(nowWall).toISOString(),
    rtoMs,
    ackedBefore: outage.ackedBefore,
    postMaxId,
    rpoOk: survived,
    promotedTo: st.body?.node ?? '?',
  };
  outages.push(rec);
  console.log(
    `\n  ── recovery ── RTO ${(rtoMs / 1000).toFixed(1)}s · ` +
      `RPO ${survived ? 'OK (0 lost)' : `BREACH (acked ${outage.ackedBefore}, post-failover max ${postMaxId})`} · ` +
      `now served by ${rec.promotedTo}\n`,
  );
  outage = null;
}

async function tick() {
  seq += 1;
  const iso = isoNow();
  const r = await fetchJson('POST', '/api/todos', { title: 'probe ' + seq });
  const nowWall = Date.now();
  const good = r.http === 201 && r.body && !!r.body.id;

  if (good) {
    successes += 1;
    if (r.body.id) maxAckedId = Math.max(maxAckedId, r.body.id);
    if (outage) await closeOutage(nowWall);
    lastSuccessWall = nowWall;
    prevSuccess = true;
  } else {
    failures += 1;
    if (prevSuccess && !outage) {
      outage = { startWall: nowWall, lastSuccessWall: lastSuccessWall ?? nowWall, ackedBefore: maxAckedId };
      console.log(`  ── outage started at ${iso} (last good id ${maxAckedId}) ──`);
    }
    prevSuccess = false;
  }

  csvRow({
    seq, iso, ok: good, http: r.http, latency: r.latency,
    id: r.body?.id, node: r.body?.origin_node, region: '',
    note: good ? '' : (r.error || `http${r.http}`),
  });
  process.stdout.write(
    `${iso}  ${good ? 'OK ' : 'DOWN'}  http=${r.http}  ${r.latency}ms  ` +
    `${good ? `id=${r.body.id} ${r.body.origin_node}` : (r.error || '')}\n`,
  );
}

function summary() {
  console.log('\n================ SUMMARY ================');
  console.log(`probed ${BASE}  ·  ${successes} ok / ${failures} failed  ·  csv: ${CSV}`);
  if (!outages.length) {
    console.log('no outage observed.');
  } else {
    outages.forEach((o, i) => {
      console.log(
        `outage #${i + 1}: ${o.downIso} → ${o.upIso}  ` +
        `RTO=${(o.rtoMs / 1000).toFixed(1)}s  ` +
        `RPO=${o.rpoOk ? '0 (no acked write lost)' : `BREACH (acked ${o.ackedBefore} > post ${o.postMaxId})`}  ` +
        `promoted→${o.promotedTo}`,
      );
    });
    const worst = Math.max(...outages.map((o) => o.rtoMs));
    console.log(`worst RTO: ${(worst / 1000).toFixed(1)}s`);
  }
  console.log('=========================================');
  process.exit(0);
}

process.on('SIGINT', summary);
process.on('SIGTERM', summary);

console.log(`probing ${BASE} every ${INTERVAL}ms — Ctrl-C for summary`);
// simple non-overlapping loop
(async function loop() {
  for (;;) {
    const started = Date.now();
    try { await tick(); } catch (e) { console.error('tick error', e); }
    const wait = Math.max(0, INTERVAL - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
})();
