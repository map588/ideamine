import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-proj-'));
let server;
let nextId = 1;
const pending = new Map();

function request(method, params = {}) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

async function call(name, args = {}) {
  const res = await request('tools/call', { name, arguments: args });
  return { text: res.result.content[0].text, isError: !!res.result.isError };
}

before(async () => {
  const env = {
    ...process.env,
    IDEAMINE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-mcp-')),
    IDEAMINE_CLAUDE_BIN: fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url)),
  };
  env.CLAUDE_CONFIG_DIR = env.IDEAMINE_HOME; // no .claude.json: the projects of this machine stay out of the tests
  env.CLAUDE_PROJECT_DIR = project; // the server pairs ideas with this folder, also when a Claude Code hook runs the tests
  server = spawn(process.execPath, [BIN, 'mcp'], { cwd: project, env, stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line); // stdout must carry nothing but JSON-RPC
    pending.get(msg.id)?.(msg);
  });
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ideamine');
  assert.ok(init.result.capabilities.tools);
  assert.ok(init.result.capabilities.prompts);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(() => server.kill());

test('lists the six tools with schemas', async () => {
  const res = await request('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name), ['idea_add', 'idea_list', 'idea_triage', 'idea_update', 'idea_next', 'idea_remove']);
  for (const t of res.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('full loop: add, triage, next, update', async () => {
  const added = await call('idea_add', { text: '- cache the API responses\n- rename helpers.js to utils.js' });
  assert.match(added.text, /Saved 2 ideas: #1, #2/);

  const work = await call('idea_triage');
  assert.match(work.text, /Ideas to triage \(2\)/);
  assert.match(work.text, /haiku/);
  assert.match(work.text, new RegExp(`project: ${path.basename(project)}`));

  const saved = await call('idea_triage', {
    by: 'test-model',
    verdicts: [
      { id: 1, verdict: 'do', impact: 4, size: 'm', model: 'sonnet', title: 'Cache API responses', why: 'slow pages', brief: 'Add an LRU cache.' },
      { id: 2, verdict: 'do', impact: 2, size: 'xs', model: 'haiku', title: 'Rename helpers.js', why: 'trivial', brief: 'Rename and fix imports.' },
    ],
  });
  assert.match(saved.text, /Saved 2 verdicts: 2 do · 0 maybe · 0 skip/);

  const next = await call('idea_next');
  assert.match(next.text, /^#2 Rename helpers\.js/); // 2/1 value per effort beats 4/3
  assert.match(next.text, /recommended model: haiku/);

  const upd = await call('idea_update', { id: 2, status: 'done', note: 'renamed' });
  assert.match(upd.text, /Updated #2 Rename helpers\.js · done · note added/);

  const board = await call('idea_list');
  assert.match(board.text, /1 open \(1 do\) · 1 done/);
  const one = await call('idea_list', { id: 1 });
  assert.match(one.text, /brief {4}Add an LRU cache\./);
  assert.match(one.text, /triaged .* by test-model/);
});

test('headless triage through the tool, while other requests stay responsive', async () => {
  await call('idea_add', { text: '- idea x\n- idea y' });
  const [triaged, pong] = await Promise.all([call('idea_triage', { headless: true }), request('ping')]);
  assert.deepEqual(pong.result, {});
  assert.match(triaged.text, /Saved 2 verdicts: 2 do · 0 maybe · 0 skip \(sonnet, 321 in \/ 45 out tokens\)/);
  assert.match((await call('idea_triage', { headless: true })).text, /inbox is empty/);
});

test('tool errors come back as isError results, not protocol errors', async () => {
  const res = await call('idea_update', { id: 999, status: 'done' });
  assert.equal(res.isError, true);
  assert.match(res.text, /no idea #999/);
  const unknown = await request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const method = await request('does/not/exist');
  assert.equal(method.error.code, -32601);
});

test('prompts mirror the skills', async () => {
  const list = await request('prompts/list');
  const names = list.result.prompts.map((p) => p.name);
  assert.deepEqual(names, ['idea', 'ideas', 'ideas-ls', 'ideas-cat', 'ideas-rm', 'ideas-find', 'ideas-groups', 'ideas-done', 'ideas-reopen', 'ideas-go', 'ideas-pipeline', 'ideas-all', 'ideas-sort', 'ideas-watch', 'ideas-web']);
  // One prompt for each skill, so that other MCP clients get the same commands as the plugin.
  assert.deepEqual([...names].sort(), fs.readdirSync(new URL('../skills', import.meta.url)).sort());
  const go = await request('prompts/get', { name: 'ideas-go', arguments: { id: '12' } });
  assert.match(go.result.messages[0].content.text, /Requested idea: 12\b[\s\S]*idea_next[\s\S]*run_in_background/);
  const got = await request('prompts/get', { name: 'idea', arguments: { text: 'teleport the cat' } });
  const text = got.result.messages[0].content.text;
  assert.match(text, /teleport the cat/);
  assert.doesNotMatch(text, /^---/);
  assert.match(text, /idea_add/);
});

// The tests below continue from the archive that the tests above left: #1, #3, #4 do; #2 done.

test('idea_list full shows the queue in full, so /ideas all can judge each idea; idea_remove deletes ideas', async () => {
  assert.match((await call('idea_list', { full: true })).text, /^#3 Idea 3\n[^]*\n\n#4 Idea 4\n[^]*\n\n#1 Cache API responses\n/);
  const none = await call('idea_remove', { ids: [] });
  assert.equal(none.isError, true);
  assert.match((await call('idea_remove', { ids: [1, 3, 4] })).text, /^Removed 3 ideas\.\n\n#1 Cache API responses\n[^]*\n\n#3 Idea 3\n/);
  assert.match((await call('idea_list')).text, /^ideamine: 0 open · 1 done/);
  assert.equal((await call('idea_list', { full: true })).text, 'No ideas match.');
});

test('idea_next with triage: true triages first, so /ideas go never has to stop', async () => {
  await call('idea_add', { text: '- first\n- second\n- third' }); // #5 #6 #7
  assert.match((await call('idea_next')).text, /^No idea is ready: 3 untriaged in the inbox\. Pass triage: true/);
  const next = await call('idea_next', { triage: true });
  assert.match(next.text, /^Saved 3 verdicts: 2 do · 0 maybe · 1 skip/);
  assert.match(next.text, /\n\n#5 Idea 5\n[^]*recommended model: sonnet\nproject dir: [^\n]*ideamine-proj-\w+ \(exists\)\n/);
  assert.match(next.text, /\n\nThe queue:\nideamine: 2 open \(2 do\)[^]*#5[^]*#6/); // to choose an idea that fits the chat

  // An explicit id triages only that idea. A saved folder that is gone is marked.
  await call('idea_add', { text: '- eighth\n- ninth', project: path.join(project, 'gone') }); // #8 #9
  const nine = (await call('idea_next', { id: 9, triage: true })).text;
  assert.match(nine, /^Saved 1 verdict: 1 do[^]*\n\n#9 Idea 9\n/);
  assert.match(nine, /project dir: [^\n]*gone \(does not exist\)$/);
  assert.match((await call('idea_list', { filter: 'inbox' })).text, /#8 +eighth/);
});

test('a manual triage shows the whole queue afterwards', async () => {
  const out = await call('idea_triage', { headless: true }); // #8, the last one in the inbox
  assert.match(out.text, /^Saved 1 verdict: 1 do[^]*\n\nideamine: 4 open \(4 do\) · 1 done\n\nDO \(best first\)\n[^]*#8 +sonnet/);
  assert.match((await call('idea_triage', { headless: true })).text, /^Nothing to triage: the inbox is empty\.\n\nideamine: 4 open/);
});
