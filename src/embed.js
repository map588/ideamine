// Search by meaning, and groups of ideas that are close in meaning. This follows memstate
// (github.com/map588/memstate): nomic-embed-text with its task prefixes, one vector for each idea
// that a content hash keeps current, cosine similarity with a threshold, and word search when the
// embedding server does not answer. The groups and the "related" links come from the vectors, so
// ideamine needs no graph database.
//
// With sync on, the ideamine server holds the vectors. It embeds each idea once for every machine,
// with its own embedding server and model. A machine that syncs reads the vectors from /api/vectors,
// sends its search queries through the server too, and keeps no vectors of its own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.js';
import { home, listIdeas, load, withLock, writeAtomic } from './store.js';
import * as sync from './sync.js';
import { clip, wordSet } from './text.js';

const MAX_CHARS = 1500; // the first cut; embed() halves a text again when the server says it is too long
const MIN_CHARS = 100;
const BATCH = 32;

/** The embedding server cannot answer. Callers then use word search. */
export class EmbedError extends Error {}

const vectorsPath = () => path.join(home(), 'vectors.json');

/** The text that stands for an idea: its title (when the text does not start with it), text, and tags. */
export function ideaText(idea) {
  const text = String(idea.text || '');
  const title = String(idea.title || '').replace(/…$/, '');
  const head = text.startsWith(title) ? text : `${idea.title}\n${text}`;
  return idea.tags?.length ? `${head}\ntags: ${idea.tags.join(', ')}` : head;
}

// nomic-embed models expect a task prefix on each side of a search. Other models get the raw text.
const isNomic = (model) => /^nomic-embed/i.test(model);
export const documentText = (model, text) => (isNomic(model) ? `search_document: ${text}` : text);
export const queryText = (model, text) => (isNomic(model) ? `search_query: ${text}` : text);

/** Base64 of the vector as little-endian float32, the form that data.json and vectors.json use. */
export function encodeVec(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf.toString('base64');
}

export function decodeVec(b64) {
  const buf = Buffer.from(b64, 'base64');
  const vec = new Float32Array(buf.length >> 2);
  for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

/** The vector scaled to length 1. */
export function unit(values) {
  const vec = Float32Array.from(values);
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) throw new EmbedError('the embedding server returned an empty vector');
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity of two unit vectors. */
export function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Cut at a code point, never inside a surrogate pair. */
const cut = (text, max) => (text.length <= max ? text : [...text].slice(0, max).join(''));

async function post(texts, { url, model, timeoutMs }) {
  const endpoint = `${url.replace(/\/+$/, '')}/embeddings`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : e.cause?.code || e.cause?.message || e.message;
    throw new EmbedError(`cannot reach ${endpoint} (${why})`);
  }
  const body = await res.text();
  if (!res.ok) {
    const err = new EmbedError(`${endpoint} answered ${res.status}: ${clip(body, 160)}`);
    err.tooLong = /too large|too long|context/i.test(body);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(body).data;
  } catch {
    data = null;
  }
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new EmbedError(`${endpoint} did not return ${texts.length} embeddings: ${clip(body, 160)}`);
  }
  return [...data].sort((a, b) => a.index - b.index).map((d) => unit(d.embedding));
}

/**
 * Unit vectors for the texts, with the document or the query prefix. When the server says that a
 * text is too long, it embeds the texts one at a time and halves each text that is still too long.
 * `url` and `model` name the embedding server; by default it is the one of this machine.
 */
export async function embed(texts, { query = false, timeoutMs = 30000, url = config.get('embed_url'), model = config.get('embed_model') } = {}) {
  const wrap = (t) => (query ? queryText(model, t) : documentText(model, t));
  const first = texts.map((t) => cut(String(t), MAX_CHARS));
  try {
    return await post(first.map(wrap), { url, model, timeoutMs });
  } catch (e) {
    if (!e.tooLong) throw e;
  }
  const out = [];
  for (let text of first) {
    for (;;) {
      try {
        out.push((await post([wrap(text)], { url, model, timeoutMs }))[0]);
        break;
      } catch (e) {
        if (!e.tooLong || text.length <= MIN_CHARS) throw e;
        text = cut(text, Math.floor([...text].length / 2));
      }
    }
  }
  return out;
}

const hashOf = (model, text) => crypto.createHash('sha256').update(`${model}\n${text}`).digest('hex').slice(0, 16);

function readVectors(model) {
  try {
    const file = JSON.parse(fs.readFileSync(vectorsPath(), 'utf8'));
    return file.model === model && file.items ? file.items : {};
  } catch {
    return {};
  }
}

/** Add vectors to the cache. Vectors of deleted ideas go, so a deleted idea leaves nothing behind. */
function saveVectors(model, entries) {
  withLock(() => {
    const live = new Set(load().ideas.map((i) => String(i.id)));
    const items = Object.fromEntries(Object.entries(readVectors(model)).filter(([id]) => live.has(id)));
    for (const [id, item] of entries) if (live.has(String(id))) items[id] = item;
    writeAtomic(vectorsPath(), JSON.stringify({ model, items }) + '\n');
  });
}

/** Vectors made here. Only new and changed ideas go to the embedding server; the others come from vectors.json. */
async function localVectors(ideas, { timeoutMs, url, model }) {
  const cached = readVectors(model);
  const vectors = new Map();
  const todo = [];
  for (const idea of ideas) {
    const text = ideaText(idea);
    const hash = hashOf(model, text);
    if (cached[idea.id]?.hash === hash) vectors.set(idea.id, decodeVec(cached[idea.id].vec));
    else todo.push({ id: idea.id, text, hash });
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const vecs = await embed(part.map((t) => t.text), { timeoutMs, url, model });
    part.forEach((t, k) => vectors.set(t.id, vecs[k]));
    saveVectors(model, part.map((t, k) => [t.id, { hash: t.hash, vec: encodeVec(vecs[k]) }]));
  }
  return vectors;
}

/** True when the vectors come from the ideamine server: sync is on. */
export const fromServer = () => sync.enabled();

const SERVER_TIMEOUT_MS = 30000;

/** The vectors of the ideamine server: { model, items: { [id]: { hash, vec } } }. Throws EmbedError. */
async function serverItems(timeoutMs = SERVER_TIMEOUT_MS) {
  const target = new URL('api/vectors', sync.serverUrl());
  let res;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : e.cause?.code || e.cause?.message || e.message;
    throw new EmbedError(`cannot reach the ideamine server ${target.origin} (${why})`);
  }
  // A server from before 0.12.0 has no /api/vectors.
  if (res.status === 404) throw new EmbedError(`the ideamine server ${target.origin} sends no vectors. Update it to ideamine 0.12.0 or later.`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: the error below shows the text.
  }
  if (!res.ok || !json?.ok || typeof json.model !== 'string' || !json.items) {
    throw new EmbedError(`the ideamine server ${target.origin} answered ${res.status}: ${json?.error || clip(text, 160)}`);
  }
  return json;
}

/**
 * Vectors from the ideamine server. An idea that the server does not have in this version yet, for
 * example after a change that waits in the outbox, is embedded through the server. Nothing is kept here.
 */
async function serverVectors(ideas, { timeoutMs }) {
  const { model, items } = await serverItems(timeoutMs);
  const url = `${sync.serverUrl()}v1`;
  const vectors = new Map();
  const todo = [];
  for (const idea of ideas) {
    const text = ideaText(idea);
    const item = items[idea.id];
    if (item?.hash === hashOf(model, text)) vectors.set(idea.id, decodeVec(item.vec));
    else todo.push({ id: idea.id, text });
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const vecs = await embed(part.map((t) => t.text), { timeoutMs, url, model });
    part.forEach((t, k) => vectors.set(t.id, vecs[k]));
  }
  return { vectors, model, url, where: `the ideamine server ${new URL(sync.serverUrl()).origin}` };
}

/**
 * A vector for each idea, with the model and the embedding server that made them, and where the
 * vectors are kept: { vectors, model, url, where }. With sync on they come from the ideamine server,
 * else from this machine. Throws EmbedError when the server does not answer.
 */
export async function vectorSet(ideas, { timeoutMs } = {}) {
  if (fromServer()) return serverVectors(ideas, { timeoutMs });
  const url = config.get('embed_url');
  const model = config.get('embed_model');
  return { vectors: await localVectors(ideas, { timeoutMs, url, model }), model, url, where: vectorsPath() };
}

/** A vector for each idea, by id. See vectorSet. */
export async function vectorsFor(ideas, options) {
  return (await vectorSet(ideas, options)).vectors;
}

/**
 * What the ideamine server sends to the machines that sync with it: its model, and the hash and the
 * vector of each idea. Ideas that have no current vector are embedded first.
 */
export async function vectorItems(ideas, { timeoutMs } = {}) {
  const model = config.get('embed_model');
  await localVectors(ideas, { timeoutMs, url: config.get('embed_url'), model });
  const cached = readVectors(model);
  return { model, items: Object.fromEntries(ideas.filter((i) => cached[i.id]).map((i) => [i.id, cached[i.id]])) };
}

/**
 * Groups of ideas that are close in meaning, by average-linkage clustering: two groups join while
 * the mean similarity of the pairs across them is at least `threshold`. The ids are sorted first,
 * so the order of the input does not change the result. Only groups of 2 or more ideas are returned.
 */
export function groupIds(ids, vectors, threshold) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const n = sorted.length;
  // sum[i][j]: sum of the similarities of all pairs across clusters i and j.
  const sum = sorted.map((a) => sorted.map((b) => cosine(vectors.get(a), vectors.get(b))));
  const clusters = sorted.map((id) => [id]);
  const alive = new Array(n).fill(true);
  for (;;) {
    let best = -Infinity;
    let pair = null;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const avg = sum[i][j] / (clusters[i].length * clusters[j].length);
        if (avg > best) {
          best = avg;
          pair = [i, j];
        }
      }
    }
    if (!pair || best < threshold) break;
    const [i, j] = pair;
    clusters[i] = [...clusters[i], ...clusters[j]].sort((a, b) => a - b);
    alive[j] = false;
    for (let k = 0; k < n; k++) {
      sum[i][k] += sum[j][k];
      sum[k][i] = sum[i][k];
    }
  }
  return clusters.filter((c, i) => alive[i] && c.length > 1);
}

// Words that many ideas use and that say little about a group ("Add full support for ...").
const LABEL_SKIP = new Set(
  'add added also app apps better build built fix full idea ideas made need new nicer now should support want work'.split(' '),
);

/** A few words that the ideas of a group share and other ideas do not, most distinctive first. */
export function groupLabel(members, all) {
  const words = (idea) => [...wordSet(`${idea.title} ${idea.text} ${(idea.tags || []).join(' ')}`)].filter((w) => !LABEL_SKIP.has(w));
  const count = (ideas) => {
    const df = new Map();
    for (const idea of ideas) for (const w of words(idea)) df.set(w, (df.get(w) || 0) + 1);
    return df;
  };
  const inside = count(members);
  const overall = count(all);
  const best = [...inside]
    .filter(([, n]) => n >= 2)
    .map(([w, n]) => [w, (n / members.length) * Math.log((all.length + 1) / (overall.get(w) || 1))])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([w]) => w);
  return best.length ? best.join(' · ') : clip(members[0].title, 40);
}

/** Groups for these ideas: [{ ids, label }], the biggest first. Throws EmbedError when the server does not answer. */
export async function groupIdeas(ideas, { threshold = config.get('group_threshold'), vectors = null, timeoutMs } = {}) {
  vectors ||= await vectorsFor(ideas, { timeoutMs });
  const byId = new Map(ideas.map((i) => [i.id, i]));
  return groupIds(ideas.map((i) => i.id), vectors, threshold)
    .map((ids) => ({ ids, label: groupLabel(ids.map((id) => byId.get(id)), ideas) }))
    .sort((a, b) => b.ids.length - a.ids.length || a.ids[0] - b.ids[0]);
}

/** The `k` ideas closest to idea `id`, with a similarity of at least `threshold`. */
export function nearest(id, ids, vectors, { k = 3, threshold = 0 } = {}) {
  const own = vectors.get(id);
  if (!own) return [];
  return ids
    .filter((other) => other !== id && vectors.has(other))
    .map((other) => ({ id: other, score: Math.round(cosine(own, vectors.get(other)) * 1000) / 1000 }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, k);
}

/** Word search for when meaning search is not available: more query words found ranks higher. */
function byWords(ideas, query) {
  const words = [...wordSet(query)];
  if (!words.length) words.push(...String(query).toLowerCase().split(/\s+/).filter(Boolean));
  return ideas
    .map((idea) => {
      const hay = `${ideaText(idea)}\n${idea.triage?.brief || ''}`.toLowerCase();
      return { idea, score: words.filter((w) => hay.includes(w)).length / words.length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.idea.id - a.idea.id);
}

/**
 * Ideas like the query, best first: { mode: 'meaning' | 'words', results: [{ idea, score }], note }.
 * When the embedding server does not answer, it falls back to word search and says why in `note`.
 */
export async function find(db, query, { filter = 'all', project = null, limit = 10, threshold, timeoutMs = 8000 } = {}) {
  const ideas = listIdeas(db, { filter, project });
  threshold ??= config.get('search_threshold');
  try {
    // The query goes to the embedding server that made the vectors, so that both come from one model.
    const { vectors, model, url } = await vectorSet(ideas, { timeoutMs });
    const [q] = await embed([query], { query: true, timeoutMs, url, model });
    const results = ideas
      .map((idea) => ({ idea, score: cosine(q, vectors.get(idea.id)) }))
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score || a.idea.id - b.idea.id);
    return { mode: 'meaning', results: limit ? results.slice(0, limit) : results, note: '' };
  } catch (e) {
    if (!(e instanceof EmbedError)) throw e;
    const results = byWords(ideas, query);
    return { mode: 'words', results: limit ? results.slice(0, limit) : results, note: e.message };
  }
}

/** Percentile `p` (0 to 1) of sorted numbers. */
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * Embed every idea that has no current vector (on the ideamine server when sync is on), then
 * describe the set, like memstate's `embed status`: coverage, the nearest-neighbour similarity of each idea, and how many ideas the
 * thresholds keep. Use it to set group_threshold and search_threshold for a new model.
 */
export async function status(db, { timeoutMs } = {}) {
  const groupThreshold = config.get('group_threshold');
  const { vectors, model, url, where } = await vectorSet(db.ideas, { timeoutMs });
  const lines = [`model ${model} at ${url}`];
  const ids = db.ideas.map((i) => i.id);
  const dim = vectors.size ? vectors.values().next().value.length : 0;
  lines.push(`vectors ${vectors.size}/${ids.length}${dim ? `, ${dim} dimensions` : ''} · ${where}`);
  if (ids.length > 1) {
    const nn = ids.map((id) => nearest(id, ids, vectors, { k: 1 })[0]?.score ?? 0).sort((a, b) => a - b);
    const p = (x) => percentile(nn, x).toFixed(2);
    lines.push(`nearest neighbour similarity: p10 ${p(0.1)} · p50 ${p(0.5)} · p90 ${p(0.9)} · max ${nn[nn.length - 1].toFixed(2)}`);
    const groups = groupIds(ids, vectors, groupThreshold);
    const grouped = groups.reduce((n, g) => n + g.length, 0);
    lines.push(`group_threshold ${groupThreshold}: ${groups.length} groups hold ${grouped} of ${ids.length} ideas`);
  }
  return lines.join('\n');
}
