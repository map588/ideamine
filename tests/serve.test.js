import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { handlePrompt } from '../src/hook.js';
import * as serve from '../src/serve.js';
import * as store from '../src/store.js';
import { startFakeServer } from './fixtures/fake-server.js';

let embedServer;
let web; // { url, port, close }

async function startWeb() {
  const server = http.createServer(serve.handler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A raw request, for headers that fetch() does not let a script set, such as Host. */
function raw(method, route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${web.url}${route}`, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A request from the page: JSON, same origin. `headers` override that. */
async function call(method, route, body = undefined, headers = {}) {
  const res = await fetch(`${web.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
}

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-serve-'));
  process.env.IDEAMINE_NO_BROWSER = '1';
  embedServer = await startFakeServer();
  process.env.IDEAMINE_EMBED_URL = `${embedServer.url}/v1`;
  web = await startWeb();
});

afterEach(async () => {
  await web.close();
  await embedServer.close();
});

test('the page and a live data.json, with an ETag that changes when the archive changes', async () => {
  store.addIdeas(['one idea']);
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /<html/i);

  const first = await call('GET', '/data.json');
  assert.equal(first.status, 200);
  assert.deepEqual([first.json.api, first.json.note, first.json.ideas[0].title, first.json.stats.open], [true, '', 'one idea', 1]);
  assert.ok(first.json.flow.times.length >= 2);
  const etag = first.headers.get('etag');
  assert.ok(etag);

  const same = await call('GET', '/data.json', undefined, { 'if-none-match': etag });
  assert.equal(same.status, 304);

  await new Promise((resolve) => setTimeout(resolve, 20)); // a later modification time
  store.addIdeas(['two']);
  const next = await call('GET', '/data.json', undefined, { 'if-none-match': etag });
  assert.equal(next.status, 200);
  assert.notEqual(next.headers.get('etag'), etag);
  assert.equal(next.json.ideas.length, 2);
});

test('without the embedding server, data.json says so and has no vectors', async () => {
  store.addIdeas(['one idea']);
  embedServer.options.down = true;
  const out = await call('GET', '/data.json');
  assert.equal(out.status, 200);
  assert.match(out.json.note, /without search by meaning/);
  assert.equal(out.json.embed.available, false);
});

test('search by meaning goes through the proxy to the embedding server', async () => {
  const out = await call('POST', '/v1/embeddings', { model: 'nomic-embed-text', input: ['search_query: money'] });
  assert.equal(out.status, 200);
  assert.equal(out.json.data[0].embedding.length, 64);
  assert.deepEqual(embedServer.inputs, ['search_query: money']);

  await embedServer.close();
  const down = await call('POST', '/v1/embeddings', { input: ['x'] });
  assert.equal(down.status, 503);
  assert.match(down.json.error, /cannot reach/);
  embedServer = await startFakeServer(); // for afterEach
});

test('the page changes ideas: status with a note, model, delete; bad input is refused', async () => {
  store.addIdeas(['one idea', 'two']);
  assert.equal((await call('POST', '/api/ideas/1', { status: 'done', note: 'shipped' })).status, 200);
  const one = store.findIdea(store.load(), 1);
  assert.deepEqual([one.status, one.notes[0].text], ['done', 'shipped']);

  assert.equal((await call('POST', '/api/ideas/2', { model: 'opus' })).status, 200);
  assert.equal(store.findIdea(store.load(), 2).triage.model, 'opus');

  const bad = await call('POST', '/api/ideas/2', { model: 'gpt' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /model must be one of/);
  assert.equal((await call('POST', '/api/ideas/2', { status: 'flying' })).status, 400);
  assert.equal((await call('POST', '/api/ideas/99', { status: 'done' })).status, 404);

  assert.equal((await call('DELETE', '/api/ideas/1')).status, 200);
  assert.equal(store.findIdea(store.load(), 1), null);
  assert.equal((await call('DELETE', '/api/ideas/1')).status, 404);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('requests from other sites are refused: a foreign Host, a form body, a cross-site fetch', async () => {
  store.addIdeas(['one idea']);
  assert.equal(await raw('GET', '/data.json', { host: 'evil.test:7411' }), 403);
  assert.equal(await raw('GET', '/data.json', { host: `localhost:${web.port}` }), 200);
  assert.equal((await call('POST', '/api/ideas/1', { status: 'done' }, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await call('POST', '/api/ideas/1', { status: 'done' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('POST', '/v1/embeddings', { input: ['x'] }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(store.findIdea(store.load(), 1).status, 'inbox');
});

test('listen() writes serve.json, and running() forgets a dead process', async () => {
  const s = await serve.listen({ port: 0 });
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual([serve.running().pid, serve.running().url], [process.pid, s.url]);
  assert.match(serve.status(), /pid/);
  await s.close();
  assert.equal(serve.running(), null);
  fs.writeFileSync(path.join(store.home(), 'serve.json'), JSON.stringify({ pid: 2 ** 22 - 7, port: 1, url: 'http://127.0.0.1:1/' }));
  assert.equal(serve.running(), null);
  assert.equal(fs.existsSync(path.join(store.home(), 'serve.json')), false);
});

test('ensureRunning() starts once, stop() ends it, and the hook answers /ideas-web without the model', async () => {
  const started = [];
  const start = (port) => {
    started.push(port);
    fs.writeFileSync(path.join(store.home(), 'serve.json'), JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/`, since: 'now' }));
  };
  assert.match(serve.ensureRunning({ start, port: 4242 }), /http:\/\/127\.0\.0\.1:4242\/ \(starting\)/);
  assert.match(serve.ensureRunning({ start, port: 4242 }), /running since now/);
  assert.deepEqual(started, [4242]);
  assert.match(await handlePrompt('/ideas-web'), /^ideamine web: http:\/\/127\.0\.0\.1:4242\/ \(running/);
  assert.equal(await handlePrompt('/ideas-web something else'), null);
  const killed = [];
  assert.match(serve.stop({ kill: (pid) => killed.push(pid) }), /stopped \(http:\/\/127\.0\.0\.1:4242\/\)/);
  assert.deepEqual(killed, [process.pid]);
  assert.equal(serve.stop(), 'ideamine web: off');
});
