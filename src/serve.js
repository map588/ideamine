// The dashboard on this machine: `ideamine serve` runs a small HTTP server on 127.0.0.1 that serves
// dashboard/index.html, builds data.json from the archive on demand, proxies search by meaning to
// the embedding server, and changes ideas for the page (start, done, drop, reopen, delete, note,
// model). `/ideas-web` starts it in the background through the hook, and `serve.json` remembers
// the process, so a second `/ideas-web` only opens the browser.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';
import { build } from './publish.js';
import { dbPath, findIdea, home, load, removeIdeas, updateIdea } from './store.js';

export const DEFAULT_PORT = 7411;
const PAGE = new URL('../dashboard/index.html', import.meta.url);
const BODY_LIMIT = 64 * 1024;
const BUILD_TIMEOUT_MS = 4000; // the embedding server must not hold the page for long
const RETRY_EMBED_MS = 60 * 1000; // after a build without vectors, before the next build tries the server again
const PROXY_TIMEOUT_MS = 8000;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const statePath = () => path.join(home(), 'serve.json');

// ---------------------------------------------------------------------------------------------
// The snapshot, built again only when the archive changed

let cache = null; // { mtime, builtAt, etag, body, note }
let building = null;

function archiveTime() {
  try {
    return fs.statSync(dbPath()).mtimeMs;
  } catch {
    return 0;
  }
}

async function snapshot() {
  const mtime = archiveTime();
  const now = Date.now();
  const fresh = cache && cache.mtime === mtime && !(cache.note && now - cache.builtAt > RETRY_EMBED_MS);
  if (fresh) return cache;
  if (!building) {
    building = build(load(), { timeoutMs: BUILD_TIMEOUT_MS })
      .then(({ data, note }) => {
        const builtAt = Date.now();
        cache = { mtime, builtAt, note, etag: `"${mtime}-${builtAt}"`, body: JSON.stringify({ ...data, api: true, note }) };
        return cache;
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

// ---------------------------------------------------------------------------------------------
// The request handler

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        reject(Object.assign(new Error('the request body is too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** True for a request that the page itself sent, not a page from another site. */
function fromThePage(req) {
  const type = String(req.headers['content-type'] || '');
  const site = req.headers['sec-fetch-site'];
  return type.startsWith('application/json') && (site === undefined || site === 'same-origin' || site === 'none');
}

async function proxyEmbeddings(body) {
  const url = `${config.get('embed_url').replace(/\/+$/, '')}/embeddings`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  } catch (e) {
    return { status: 503, body: JSON.stringify({ error: `cannot reach ${url} (${e.cause?.code || e.name})` }) };
  }
  return { status: res.status, body: await res.text() };
}

async function changeIdea(req, id) {
  if (!findIdea(load(), id)) return json(req.res, 404, { error: `no idea #${id}` });
  if (req.method === 'DELETE') {
    removeIdeas([id]);
    return json(req.res, 200, { ok: true, id });
  }
  let patch;
  try {
    patch = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return json(req.res, e.status || 400, { error: e.status ? e.message : 'the body is not valid JSON' });
  }
  const { status, note, model } = patch || {};
  try {
    updateIdea(id, { status, note, model });
  } catch (e) {
    return json(req.res, 400, { error: e.message });
  }
  return json(req.res, 200, { ok: true, id });
}

async function route(req, res) {
  req.res = res;
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return json(res, 403, { error: 'the dashboard answers only on localhost' });
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(PAGE));
  }
  if (req.method === 'GET' && p === '/data.json') {
    const snap = await snapshot();
    if (req.headers['if-none-match'] === snap.etag) return res.writeHead(304, { etag: snap.etag }).end();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', etag: snap.etag });
    return res.end(snap.body);
  }

  const idea = /^\/api\/ideas\/(\d+)$/.exec(p);
  const mutation = (req.method === 'POST' && (p === '/v1/embeddings' || idea)) || (req.method === 'DELETE' && idea);
  if (!mutation) return json(res, 404, { error: `no route for ${req.method} ${p}` });
  if (!fromThePage(req)) return json(res, 403, { error: 'only the dashboard page can send this request' });

  if (p === '/v1/embeddings') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
    const out = await proxyEmbeddings(body);
    res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(out.body);
  }
  return changeIdea(req, Number(idea[1]));
}

/** The request handler, for http.createServer. Exported so the tests can run it on any port. */
export function handler() {
  return (req, res) => {
    route(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    });
  };
}

// ---------------------------------------------------------------------------------------------
// The process: start, find, stop

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

const urlFor = (port) => `http://127.0.0.1:${port}/`;

/** Start the server. Resolves to { url, port, close } once it listens. A busy port is an error. */
export function listen({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler());
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is in use. Pass --port <number>`) : e));
    server.listen(port, host, () => {
      const actual = server.address().port;
      const url = urlFor(actual);
      fs.mkdirSync(home(), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify({ pid: process.pid, port: actual, url, since: new Date().toISOString() }, null, 2) + '\n');
      const close = () =>
        new Promise((done) => {
          if (readState()?.pid === process.pid) fs.rmSync(statePath(), { force: true });
          server.close(() => done());
          server.closeAllConnections?.();
        });
      resolve({ url, port: actual, close });
    });
  });
}

/** The running server from serve.json: { pid, port, url, since }, or null. A dead pid clears the file. */
export function running() {
  const state = readState();
  if (!state?.pid) return null;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    fs.rmSync(statePath(), { force: true });
    return null;
  }
}

function startProcess(port) {
  const bin = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
  spawn(process.execPath, [bin, 'serve', '--port', String(port)], { cwd: home(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Start the server in the background when it does not run. Returns the line to show. */
export function ensureRunning({ start = startProcess, port = DEFAULT_PORT } = {}) {
  const state = running();
  if (state) return `ideamine web: ${state.url} (running since ${state.since})`;
  start(port);
  return `ideamine web: ${urlFor(port)} (starting)`;
}

/** Stop the background server. Returns the line to show. */
export function stop({ kill = (pid) => process.kill(pid) } = {}) {
  const state = running();
  if (!state) return 'ideamine web: off';
  try {
    kill(state.pid);
  } catch {
    // It stopped between running() and now.
  }
  fs.rmSync(statePath(), { force: true });
  return `ideamine web: stopped (${state.url})`;
}

export function status() {
  const state = running();
  return state ? `ideamine web: ${state.url} (pid ${state.pid}, since ${state.since})` : 'ideamine web: off. `ideamine serve` or /ideas-web starts it.';
}

/** Open `url` in the default browser, if the platform has a way. Never throws. */
export function openBrowser(url) {
  if (process.env.IDEAMINE_NO_BROWSER) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser opener on this system: the URL is in the message.
  }
}
