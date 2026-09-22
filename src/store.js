// The idea archive: one JSON file shared by every Claude session, project, and model.
// Writers take a directory lock and replace the file atomically, so concurrent sessions,
// the hook, and the CLI can all write at once without losing ideas.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProject, samePath } from './projects.js';
import { clip, deriveTitle, extractTags, isSimilar, normalizeTags, wordSet } from './text.js';

export const VERDICTS = ['do', 'maybe', 'skip'];
export const SIZES = ['xs', 's', 'm', 'l', 'xl'];
export const SIZE_COST = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };
export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'];
export const STATUSES = ['inbox', 'triaged', 'doing', 'done', 'dropped'];
export const FILTERS = ['open', 'inbox', 'do', 'maybe', 'skip', 'doing', 'done', 'dropped', 'all'];

const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 8000;

export function home() {
  return process.env.IDEAMINE_HOME || path.join(os.homedir(), '.ideamine');
}

export function dbPath() {
  return path.join(home(), 'ideas.json');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const now = () => new Date().toISOString();

function emptyDb() {
  return { version: 1, next_id: 1, ideas: [] };
}

/** Read-only snapshot. Safe without the lock because writes are atomic renames. */
export function load() {
  const file = dbPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyDb();
    throw e;
  }
  if (!raw.trim()) return emptyDb();
  let db;
  try {
    db = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it, or restore ${file}.bak`);
  }
  if (!db || !Array.isArray(db.ideas)) throw new Error(`${file} has no "ideas" array`);
  const maxId = db.ideas.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
  db.next_id = Math.max(Number(db.next_id) || 1, maxId + 1);
  return db;
}

function acquireLock() {
  fs.mkdirSync(home(), { recursive: true });
  const lockDir = path.join(home(), '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      // A writer holds the lock for milliseconds; an old lock means a crashed process.
      if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      // The lock vanished between mkdir and stat; the next attempt will likely get it.
    }
    if (Date.now() > deadline) {
      throw new Error(`idea store is busy (lock: ${lockDir}). Delete that folder if no ideamine process is running.`);
    }
    sleepSync(Math.min(10 + attempt * 5, 100));
  }
}

function renameWithRetry(from, to) {
  // Windows refuses to replace a file that another program (editor, antivirus, sync) has open.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        fs.rmSync(from, { force: true });
        throw e;
      }
      sleepSync(25);
    }
  }
}

/** Replace `file` in one step, so a reader never sees half a file. Call it while you hold the lock. */
export function writeAtomic(file, text, { backup = false } = {}) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  if (backup) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  renameWithRetry(tmp, file);
}

function save(db) {
  writeAtomic(dbPath(), JSON.stringify(db, null, 2) + '\n', { backup: true });
}

/** Run `fn` while this process holds the archive lock. Other files in home() can share the lock. */
export function withLock(fn) {
  const release = acquireLock();
  try {
    return fn();
  } finally {
    release();
  }
}

/** Lock, read, apply `fn(db)`, write. Nothing is written if `fn` throws. */
export function mutate(fn) {
  return withLock(() => {
    const db = load();
    const result = fn(db);
    save(db);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Queries

export function findIdea(db, id) {
  const n = Number(String(id).replace(/^#/, ''));
  return db.ideas.find((i) => i.id === n) || null;
}

export function verdictOf(idea) {
  return idea.status === 'triaged' ? idea.triage?.verdict || null : null;
}

/** Value per unit of effort; untriaged ideas sort last. */
export function priority(idea) {
  const t = idea.triage;
  if (!t) return 0;
  return (Number(t.impact) || 3) / (SIZE_COST[t.size] || 3);
}

/** Lane an idea shows up in on the board. */
export function lane(idea) {
  if (idea.status === 'triaged') return idea.triage?.verdict || 'maybe';
  return idea.status;
}

/** The lanes of the board, in the order they are shown. */
export const LANES = ['doing', 'do', 'maybe', 'inbox', 'skip', 'done', 'dropped'];

export function matchesFilter(idea, filter) {
  const l = lane(idea);
  switch (filter) {
    case 'all':
      return true;
    case 'open':
      return ['doing', 'do', 'maybe', 'inbox'].includes(l);
    default:
      return l === filter;
  }
}

export function listIdeas(db, { filter = 'open', project = null, query = '', limit = 0 } = {}) {
  if (!FILTERS.includes(filter)) throw new Error(`unknown filter "${filter}" (use: ${FILTERS.join(', ')})`);
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  let ideas = db.ideas.filter((i) => matchesFilter(i, filter));
  if (project) ideas = ideas.filter((i) => samePath(i.project, project));
  if (words.length) {
    ideas = ideas.filter((i) => {
      const hay = `${i.title}\n${i.text}\n${(i.tags || []).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  ideas.sort((a, b) => {
    const la = LANES.indexOf(lane(a));
    const lb = LANES.indexOf(lane(b));
    if (la !== lb) return la - lb;
    if (['done', 'dropped', 'inbox'].includes(lane(a))) return b.id - a.id; // newest first
    return priority(b) - priority(a) || a.id - b.id;
  });
  return limit > 0 ? ideas.slice(0, limit) : ideas;
}

export function counts(db) {
  const c = { inbox: 0, do: 0, maybe: 0, skip: 0, doing: 0, done: 0, dropped: 0 };
  for (const i of db.ideas) c[lane(i)] = (c[lane(i)] || 0) + 1;
  c.open = c.inbox + c.do + c.maybe + c.doing;
  return c;
}

const READY_LANES = ['do', 'maybe'];

/**
 * Best idea to build next: verdict "do" before "maybe", not started, current project first, then
 * value per effort. A "maybe" idea is still in the queue, so /ideas-go builds it when no "do" is left.
 */
export function pickNext(db, { project = null, only = false } = {}) {
  let ready = db.ideas.filter((i) => READY_LANES.includes(lane(i)));
  if (only) ready = ready.filter((i) => samePath(i.project, project));
  ready.sort((a, b) => {
    const pa = project && samePath(a.project, project) ? 1 : 0;
    const pb = project && samePath(b.project, project) ? 1 : 0;
    return READY_LANES.indexOf(lane(a)) - READY_LANES.indexOf(lane(b)) || pb - pa || priority(b) - priority(a) || a.id - b.id;
  });
  return ready[0] || null;
}

function similarTo(db, text, excludeId) {
  const words = wordSet(text);
  if (words.size < 2) return [];
  return db.ideas
    .filter((i) => i.id !== excludeId && i.status !== 'dropped' && isSimilar(words, wordSet(`${i.title} ${i.text}`)))
    .slice(-2)
    .map((i) => ({ id: i.id, title: i.title, status: lane(i) }));
}

// ---------------------------------------------------------------------------------------------
// Mutations

export function addIdeas(texts, { source = 'mcp', project = null, session = null, tags = [] } = {}) {
  const items = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!items.length) throw new Error('idea text is empty');
  return mutate((db) =>
    items.map((text) => {
      const similar = similarTo(db, text, null);
      const stamp = now();
      const idea = {
        id: db.next_id++,
        title: deriveTitle(text),
        text,
        status: 'inbox',
        tags: normalizeTags([...extractTags(text), ...normalizeTags(tags)]),
        project: project ? path.resolve(project) : null,
        source,
        created: stamp,
        updated: stamp,
        triage: null,
        notes: [],
      };
      if (session) idea.session = String(session);
      db.ideas.push(idea);
      return { idea, similar };
    }),
  );
}

export function normalizeModel(model) {
  const m = String(model || '').toLowerCase();
  return MODEL_ALIASES.find((alias) => m.includes(alias)) || null;
}

function cleanVerdict(v) {
  const verdict = String(v.verdict || '').toLowerCase();
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join('/')}`);
  const impact = Math.min(5, Math.max(1, Math.round(Number(v.impact) || 3)));
  const size = SIZES.includes(String(v.size || '').toLowerCase()) ? String(v.size).toLowerCase() : 'm';
  const model = normalizeModel(v.model) || 'sonnet';
  return {
    verdict,
    impact,
    size,
    model,
    why: clip(v.why || '', 300),
    brief: verdict === 'skip' ? '' : String(v.brief || '').trim().slice(0, 2000),
  };
}

/**
 * Save triage verdicts. Bad items are reported individually instead of failing the batch.
 * `projects` are the folders that the triage could pair ideas with (from knownProjects). A verdict
 * that names one of them moves its idea there.
 */
export function applyTriage(verdicts, { by = null, projects = null } = {}) {
  if (!Array.isArray(verdicts) || !verdicts.length) throw new Error('no verdicts given');
  return mutate((db) =>
    verdicts.map((v) => {
      const idea = findIdea(db, v?.id);
      if (!idea) return { id: v?.id, error: 'no such idea' };
      let t;
      try {
        t = cleanVerdict(v);
      } catch (e) {
        return { id: idea.id, error: e.message };
      }
      idea.triage = { ...t, at: now(), ...(by ? { by } : {}), ...(projects ? { paired: true } : {}) };
      if (v.title) idea.title = clip(v.title, 90);
      if (Array.isArray(v.tags)) idea.tags = normalizeTags([...(idea.tags || []), ...v.tags]);
      const dup = Number(v.dup_of);
      if (dup && dup !== idea.id && findIdea(db, dup)) idea.dup_of = dup;
      const target = projects && findProject(projects, v.project);
      let moved = null;
      if (target && !samePath(target.dir, idea.project)) {
        idea.notes ||= [];
        idea.notes.push({ at: now(), text: `paired with ${target.dir} (was ${idea.project || 'no folder'})` });
        idea.project = target.dir;
        moved = target.dir;
      }
      if (idea.status === 'inbox') idea.status = 'triaged';
      idea.updated = now();
      return { id: idea.id, verdict: t.verdict, model: t.model, size: t.size, title: idea.title, ...(moved ? { moved } : {}) };
    }),
  );
}

/** Delete ideas for good and return them. An unknown id is an error, and then nothing is deleted. */
export function removeIdeas(ids) {
  return mutate((db) => {
    const gone = ids.map((id) => {
      const idea = findIdea(db, id);
      if (!idea) throw new Error(`no idea #${String(id).replace(/^#/, '')}`);
      return idea;
    });
    db.ideas = db.ideas.filter((i) => !gone.includes(i));
    return [...new Set(gone)];
  });
}

const STATUS_ALIASES = { start: 'doing', started: 'doing', finish: 'done', finished: 'done', drop: 'dropped' };

export function updateIdea(id, patch = {}) {
  return mutate((db) => {
    const idea = findIdea(db, id);
    if (!idea) throw new Error(`no idea #${id}`);
    if (patch.status) {
      let status = String(patch.status).toLowerCase();
      status = STATUS_ALIASES[status] || status;
      if (status === 'reopen' || status === 'open') status = idea.triage ? 'triaged' : 'inbox';
      if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}, or reopen`);
      // The dashboard timeline shows work from the latest start.
      if (status === 'doing' && idea.status !== 'doing') idea.started = now();
      idea.status = status;
      if (status === 'done' || status === 'dropped') idea.closed = now();
      else delete idea.closed;
    }
    if (patch.text) idea.text = String(patch.text).trim();
    if (patch.title) idea.title = clip(patch.title, 90);
    else if (patch.text) idea.title = deriveTitle(idea.text);
    if (Array.isArray(patch.tags)) idea.tags = normalizeTags(patch.tags);
    if (patch.project !== undefined) idea.project = patch.project ? path.resolve(patch.project) : null;
    if (patch.model) {
      const model = normalizeModel(patch.model);
      if (!model) throw new Error(`model must be one of ${MODEL_ALIASES.join(', ')}`);
      idea.triage = { ...(idea.triage || { verdict: 'do', impact: 3, size: 'm', why: '', brief: '' }), model };
      if (idea.status === 'inbox') idea.status = 'triaged';
    }
    if (patch.note) {
      idea.notes ||= [];
      idea.notes.push({ at: now(), text: String(patch.note).trim() });
    }
    idea.updated = now();
    return idea;
  });
}
