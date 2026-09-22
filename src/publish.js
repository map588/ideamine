// The dashboard: a static page (dashboard/index.html) and a snapshot of the archive (data.json).
// `ideamine publish` uploads both with HTTP PUT, for example to nginx on a WireGuard address, or
// writes them to a folder. Like the watcher, no process stays alive: the hook calls kick() for
// each prompt, and kick() starts a background publish when the archive changed since the last one.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';
import * as embed from './embed.js';
import { counts, dbPath, home, lane, LANES, listIdeas, load, MODEL_ALIASES, SIZES } from './store.js';

const PAGE = new URL('../dashboard/index.html', import.meta.url);
const WAIT_AFTER_ERROR_MS = 10 * 60 * 1000; // after a failed publish, before kick() tries again
const LOCK_STALE_MS = 10 * 60 * 1000;

const statePath = () => path.join(home(), 'publish.json');
const lockPath = () => path.join(home(), '.publish');

/** The earliest of the given times; null when none is set. */
const earliest = (...times) => times.filter(Boolean).sort()[0] || null;

/**
 * Bars for the timeline: the time an idea waited in the inbox, waited in the queue, and was in work.
 * `to: null` means "until now". Ideas that started before ideamine recorded start times get an
 * `estimated` work bar from the triage (or the creation) to the end.
 */
export function phases(idea) {
  const triaged = idea.triage?.at || null;
  const started = idea.started || null;
  const closed = idea.closed || null;
  const out = [];
  const add = (phase, from, to, estimated = false) => {
    if (from && (!to || to >= from)) out.push(estimated ? { phase, from, to, estimated } : { phase, from, to });
  };
  if (!started && (idea.status === 'doing' || idea.status === 'done')) {
    if (triaged) add('inbox', idea.created, triaged);
    add('doing', triaged || idea.created, closed, true);
    return out;
  }
  add('inbox', idea.created, earliest(triaged, started, closed));
  if (triaged && (!started || triaged < started)) add('queued', triaged, started || closed);
  if (started) add('doing', started, closed);
  return out;
}

const DAY = 86400000;
const OPEN_LANES = ['inbox', 'do', 'maybe', 'doing'];

/**
 * The lane of an idea at time `t` (ms), with the same rules as phases(): null before the idea
 * exists. A done idea without a recorded close time closed at its last update.
 */
export function laneAt(idea, t) {
  const at = (time) => (time ? Date.parse(time) : NaN);
  if (!(t >= at(idea.created))) return null;
  const closedStatus = idea.status === 'done' || idea.status === 'dropped';
  if (closedStatus && t >= at(idea.closed || idea.updated)) return idea.status;
  if (t >= at(idea.started)) return 'doing';
  const triaged = at(idea.triage?.at);
  if (!idea.started && idea.status === 'doing' && t >= (triaged || at(idea.created))) return 'doing';
  if (t >= triaged) return idea.triage?.verdict || 'maybe';
  return 'inbox';
}

/**
 * Cumulative flow: `times` (ISO, up to `samples` evenly spaced from the first idea to now) and
 * `series`, a count for each lane at each time. At every time, the lanes add up to the ideas that
 * existed then.
 */
export function flow(ideas, { samples = 60, now = Date.now() } = {}) {
  const series = Object.fromEntries(LANES.map((l) => [l, []]));
  const starts = ideas.map((i) => Date.parse(i.created)).filter(Number.isFinite);
  if (!starts.length) return { times: [], series };
  const first = Math.min(...starts, now);
  const span = Math.max(now - first, 1);
  const n = Math.max(2, Math.min(samples, span + 1)); // a step of 1 ms at least, so the times differ
  const times = [];
  for (let k = 0; k < n; k++) {
    const t = first + Math.round((span * k) / (n - 1));
    times.push(new Date(t).toISOString());
    for (const l of LANES) series[l].push(0);
    for (const idea of ideas) {
      const l = laneAt(idea, t);
      if (l && series[l]) series[l][k]++;
    }
  }
  return { times, series };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The tiles of the Flow view: what is open, what closed in the last 7 days, and how long ideas take. */
export function stats(ideas, { now = Date.now() } = {}) {
  const week = now - 7 * DAY;
  const open = ideas.filter((i) => OPEN_LANES.includes(lane(i)));
  const closedSince = (status) => ideas.filter((i) => i.status === status && Date.parse(i.closed) >= week).length;
  const done = ideas.filter((i) => i.status === 'done' && i.closed);
  const count = (keys, pick) => Object.fromEntries(keys.map((k) => [k, open.filter((i) => pick(i) === k).length]));
  return {
    open: open.length,
    done_7d: closedSince('done'),
    dropped_7d: closedSince('dropped'),
    lead_median_ms: median(done.map((i) => Date.parse(i.closed) - Date.parse(i.created))),
    cycle_median_ms: median(done.filter((i) => i.started).map((i) => Date.parse(i.closed) - Date.parse(i.started))),
    oldest_open_ms: open.length ? Math.max(...open.map((i) => now - Date.parse(i.created))) : null,
    models: count(MODEL_ALIASES, (i) => i.triage?.model),
    sizes: count(SIZES, (i) => i.triage?.size),
  };
}

/** data.json (version 1). The dashboard page reads it; its format is in the README. */
export function snapshot(db, { vectors = null, groups = [], generated = new Date().toISOString() } = {}) {
  const model = config.get('embed_model');
  const groupThreshold = config.get('group_threshold');
  const rank = new Map(listIdeas(db, { filter: 'all' }).map((idea, n) => [idea.id, n]));
  const groupOf = new Map();
  groups.forEach((g, n) => g.ids.forEach((id) => groupOf.set(id, n)));
  const ids = db.ideas.map((i) => i.id);
  return {
    version: 1,
    generated,
    embed: {
      model,
      dim: vectors?.size ? vectors.values().next().value.length : 0,
      query_prefix: embed.queryText(model, ''),
      search_threshold: config.get('search_threshold'),
      group_threshold: groupThreshold,
      available: !!vectors,
    },
    counts: counts(db),
    ideas: db.ideas.map((i) => {
      const t = i.triage;
      return {
        id: i.id,
        key: `IDEA-${i.id}`,
        title: i.title,
        text: i.text,
        lane: lane(i),
        status: i.status,
        rank: rank.get(i.id),
        tags: i.tags || [],
        project: i.project ? path.basename(i.project) : null,
        created: i.created,
        updated: i.updated,
        triaged: t?.at || null,
        started: i.started || null,
        closed: i.closed || null,
        verdict: t?.verdict || null,
        impact: t?.impact ?? null,
        size: t?.size || null,
        model: t?.model || null,
        why: t?.why || '',
        brief: t?.brief || '',
        notes: i.notes || [],
        dup_of: i.dup_of || null,
        group: groupOf.has(i.id) ? groupOf.get(i.id) : null,
        related: vectors ? embed.nearest(i.id, ids, vectors, { k: 3, threshold: groupThreshold }) : [],
        phases: phases(i),
        vec: vectors?.has(i.id) ? embed.encodeVec(vectors.get(i.id)) : null,
      };
    }),
    groups: groups.map((g, n) => ({ id: n, label: g.label, ids: g.ids })),
    flow: flow(db.ideas, { now: Date.parse(generated) }),
    stats: stats(db.ideas, { now: Date.parse(generated) }),
  };
}

/** The snapshot, with groups when the embedding server answers. `note` says why there are none. */
export async function build(db, { timeoutMs = 60000 } = {}) {
  let vectors = null;
  let groups = [];
  let note = '';
  try {
    vectors = await embed.vectorsFor(db.ideas, { timeoutMs });
    groups = await embed.groupIdeas(db.ideas, { vectors });
  } catch (e) {
    if (!(e instanceof embed.EmbedError)) throw e;
    vectors = null;
    note = `published without search by meaning or groups: ${e.message}`;
  }
  return { data: snapshot(db, { vectors, groups }), note };
}

async function put(url, body, type) {
  let res;
  try {
    res = await fetch(url, { method: 'PUT', body, headers: { 'content-type': type }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`cannot reach ${url} (${e.name === 'TimeoutError' ? 'no answer in 30 s' : e.cause?.code || e.cause?.message || e.message})`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}`);
}

const pageHash = () => crypto.createHash('sha256').update(fs.readFileSync(PAGE)).digest('hex').slice(0, 16);

function archiveTime() {
  try {
    return fs.statSync(dbPath()).mtimeMs;
  } catch {
    return 0;
  }
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2) + '\n');
}

/**
 * Upload index.html and data.json to `url` (a folder URL on the dashboard server), or write them
 * to the folder `dir`. Returns what it did, for the caller to show.
 */
export async function publish({ url = config.get('publish_url'), dir = null } = {}) {
  if (!url && !dir) throw new Error('no dashboard server is set. Run `ideamine publish <url>` once, or pass --dir <folder>');
  const mtime = archiveTime();
  const { data, note } = await build(load());
  const files = [
    ['data.json', JSON.stringify(data), 'application/json'],
    ['index.html', fs.readFileSync(PAGE), 'text/html; charset=utf-8'],
  ];
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of files) fs.writeFileSync(path.join(dir, name), body);
  } else {
    const base = url.endsWith('/') ? url : `${url}/`;
    for (const [name, body, type] of files) await put(new URL(name, base), body, type);
    writeState({ at: new Date().toISOString(), mtime, page: pageHash(), url, error: null, errorAt: null });
  }
  return { where: dir || url, ideas: data.ideas.length, groups: data.groups.length, note };
}

function isRunning(now) {
  try {
    return now - fs.statSync(lockPath()).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** One background publish, from kick(). Only one runs at a time, and a failure waits 10 minutes. */
export async function backgroundPublish() {
  fs.mkdirSync(home(), { recursive: true });
  try {
    fs.mkdirSync(lockPath());
  } catch (e) {
    if (e.code !== 'EEXIST' || isRunning(Date.now())) return 'busy';
    fs.utimesSync(lockPath(), new Date(), new Date()); // take over the lock of a crashed publish
  }
  try {
    await publish();
    return 'done';
  } catch (e) {
    writeState({ error: e.message, errorAt: new Date().toISOString() });
    return 'error';
  } finally {
    fs.rmSync(lockPath(), { recursive: true, force: true });
  }
}

function startProcess() {
  const bin = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
  spawn(process.execPath, [bin, 'publish', '--background'], { cwd: home(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Start a background publish when a dashboard server is set, the archive or the page changed since
 * the last publish, no publish runs, and no publish failed a short time ago.
 */
export function kick({ start = startProcess, now = Date.now() } = {}) {
  const url = config.get('publish_url');
  if (!url) return false;
  const state = readState();
  if (state.errorAt && now - Date.parse(state.errorAt) < WAIT_AFTER_ERROR_MS) return false;
  if (isRunning(now)) return false;
  const current = state.url === url && archiveTime() <= (state.mtime || 0) && state.page === pageHash();
  if (current) return false;
  start();
  return true;
}

/** Where the dashboard goes and how the last publish went. */
export function status() {
  const url = config.get('publish_url');
  if (!url) return 'ideamine publish: off. `ideamine publish <url>` sets the dashboard server.';
  const s = readState();
  const lines = [`ideamine publish: ${url}`];
  lines.push(s.at ? `last publish ${s.at}` : 'not published yet');
  if (s.error) lines.push(`the last background publish failed at ${s.errorAt}: ${s.error}`);
  return lines.join('\n');
}
