// Search by meaning with sync on: the ideamine server holds the vectors. It embeds each idea once
// for every machine, and a machine that syncs reads the vectors from it and keeps none of its own.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import * as archive from '../src/archive.js';
import * as embed from '../src/embed.js';
import * as publish from '../src/publish.js';
import * as serve from '../src/serve.js';
import * as store from '../src/store.js';
import { DIM, startFakeServer } from './fixtures/fake-server.js';
import { freePort, startServerProcess } from './fixtures/server-process.js';

const SERVER_MODEL = 'nomic-embed-text-v1.5'; // not the default, so a test sees whose model a machine uses

let embedder; // the embedding server of the ideamine server
let server; // the ideamine server, in its own process

before(async () => {
  embedder = await startFakeServer();
  server = await startServerProcess({ IDEAMINE_EMBED_URL: `${embedder.url}/v1`, IDEAMINE_EMBED_MODEL: SERVER_MODEL });
});

after(async () => {
  await server.stop();
  await embedder.close();
});

beforeEach(() => {
  for (const name of ['ideas.json', 'ideas.json.bak', 'applied.json', 'vectors.json']) fs.rmSync(path.join(server.home, name), { force: true });
  embedder.inputs.length = 0;
  // A machine that syncs: its own copy of the archive, and an embedding server of its own where
  // nothing listens. With sync on it must never be used.
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-machine-'));
  process.env.IDEAMINE_SYNC_URL = server.url;
  process.env.IDEAMINE_EMBED_URL = 'http://127.0.0.1:9/v1';
  delete process.env.IDEAMINE_EMBED_MODEL;
});

const vectorsHere = () => fs.existsSync(path.join(store.home(), 'vectors.json'));

test('the server sends its model and the vector of each idea, and embeds each idea only once', async () => {
  await archive.add(['subtitles for audiobooks', 'dark mode for the popup']);
  const first = await (await fetch(`${server.url}api/vectors`)).json();
  assert.equal(first.ok, true);
  assert.equal(first.model, SERVER_MODEL);
  assert.deepEqual(Object.keys(first.items).sort(), ['1', '2']);
  assert.equal(embed.decodeVec(first.items[1].vec).length, DIM);
  assert.deepEqual(embedder.inputs, ['search_document: subtitles for audiobooks', 'search_document: dark mode for the popup']);
  const again = await (await fetch(`${server.url}api/vectors`)).json();
  assert.deepEqual(again.items, first.items);
  assert.equal(embedder.inputs.length, 2); // from the cache of the server
});

test('with sync on, search and groups read the vectors from the server, and this machine keeps none', async () => {
  await archive.add(['subtitles for audiobooks in the reader', 'a tor exit relay on the server', 'subtitles in the video player']);
  const found = await embed.find(await archive.fresh(), 'subtitles audiobooks reader', { threshold: 0.3 });
  assert.equal(found.mode, 'meaning', found.note);
  assert.deepEqual(found.results.map((r) => r.idea.id), [1, 3]);
  // The server embedded the ideas once, and the query went through the server to the same model.
  assert.equal(embedder.inputs.length, 4);
  assert.equal(embedder.inputs.at(-1), 'search_query: subtitles audiobooks reader');
  const groups = await embed.groupIdeas(store.load().ideas, { threshold: 0.3 });
  assert.deepEqual(groups.map((g) => g.ids), [[1, 3]]);
  assert.equal(embedder.inputs.length, 4); // the groups needed no new vectors
  const status = await embed.status(store.load());
  assert.match(status, new RegExp(`^model ${SERVER_MODEL} at ${server.url}v1$`, 'm'));
  assert.match(status, /vectors 3\/3, 64 dimensions · the ideamine server http:\/\/127\.0\.0\.1:\d+$/m);
  assert.equal(vectorsHere(), false);
});

test('an idea that the server has in another version is embedded through the server, and not kept here', async () => {
  await archive.add(['dark mode for the popup']);
  await fetch(`${server.url}api/vectors`); // the server embeds its version
  store.updateIdea(1, { text: 'dark mode for the settings page' }); // the copy here differs from the server
  embedder.inputs.length = 0;
  const vectors = await embed.vectorsFor(store.load().ideas);
  assert.equal(vectors.size, 1);
  assert.deepEqual(embedder.inputs, ['search_document: dark mode for the settings page']);
  assert.equal(vectorsHere(), false);
});

test('the dashboard of a machine with sync on uses the model of the server, and its searches go there', async () => {
  await archive.add(['subtitles for audiobooks', 'dark mode for the popup']);
  const { data, note } = await publish.build(await archive.fresh());
  assert.equal(note, '');
  assert.equal(data.embed.model, SERVER_MODEL);
  assert.equal(data.embed.available, true);
  assert.ok(data.ideas.every((i) => i.vec));
  const page = await serve.start({ port: 0, afterChange: () => {} });
  try {
    const res = await fetch(new URL('v1/embeddings', page.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: data.embed.model, input: [`${data.embed.query_prefix}subtitles`] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].embedding.length, DIM);
    assert.equal(embedder.inputs.at(-1), 'search_query: subtitles');
  } finally {
    await new Promise((resolve) => page.server.close(resolve));
  }
  assert.equal(vectorsHere(), false);
});

test('search falls back to words and says why when the server sends no vectors or does not answer', async () => {
  store.addIdeas(['subtitles for audiobooks', 'dark mode']);
  const old = await startFakeServer(); // like a server from before 0.12.0: no /api/vectors
  process.env.IDEAMINE_SYNC_URL = `${old.url}/`;
  try {
    const found = await embed.find(store.load(), 'audiobooks subtitles');
    assert.equal(found.mode, 'words');
    assert.match(found.note, /sends no vectors\. Update it to ideamine 0\.12\.0 or later/);
    assert.deepEqual(found.results.map((r) => r.idea.id), [1]);
  } finally {
    await old.close();
  }
  process.env.IDEAMINE_SYNC_URL = `http://127.0.0.1:${await freePort()}/`; // the tunnel is down
  const offline = await embed.find(store.load(), 'dark', { timeoutMs: 5000 });
  assert.equal(offline.mode, 'words');
  assert.match(offline.note, /cannot reach the ideamine server http:\/\/127\.0\.0\.1:\d+ \((ECONNREFUSED|no answer)/);
  assert.equal(vectorsHere(), false);
});
