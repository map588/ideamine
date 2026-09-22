import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import fc from 'fast-check';
import * as config from '../src/config.js';
import * as embed from '../src/embed.js';
import * as publish from '../src/publish.js';
import * as store from '../src/store.js';
import { startFakeServer } from './fixtures/fake-server.js';

let server;

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-publish-'));
  server = await startFakeServer();
  process.env.IDEAMINE_EMBED_URL = `${server.url}/v1`;
  for (const name of ['IDEAMINE_PUBLISH_URL', 'IDEAMINE_EMBED_MODEL', 'IDEAMINE_GROUP_THRESHOLD', 'IDEAMINE_SEARCH_THRESHOLD']) delete process.env[name];
});

afterEach(() => server.close());

const T = (h) => `2026-09-21T${String(h).padStart(2, '0')}:00:00.000Z`;

test('timeline phases follow the inbox, the queue, and the work', () => {
  const base = { id: 1, created: T(1), status: 'inbox' };
  assert.deepEqual(publish.phases(base), [{ phase: 'inbox', from: T(1), to: null }]);
  const queued = { ...base, status: 'triaged', triage: { at: T(2) } };
  assert.deepEqual(publish.phases(queued), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'queued', from: T(2), to: null },
  ]);
  const done = { ...queued, status: 'done', started: T(3), closed: T(5) };
  assert.deepEqual(publish.phases(done), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'queued', from: T(2), to: T(3) },
    { phase: 'doing', from: T(3), to: T(5) },
  ]);
  // Done before start times were recorded: the work bar is a guess, and says so.
  assert.deepEqual(publish.phases({ ...queued, status: 'done', closed: T(5) }), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'doing', from: T(2), to: T(5), estimated: true },
  ]);
  assert.deepEqual(publish.phases({ ...base, status: 'dropped', closed: T(4) }), [{ phase: 'inbox', from: T(1), to: T(4) }]);
});

test('the snapshot has a ticket for each idea, groups, related ideas, and the vectors', async () => {
  process.env.IDEAMINE_GROUP_THRESHOLD = '0.5';
  store.addIdeas(['subtitles for audiobooks', 'subtitles for audiobooks on android', 'a tor exit relay'], { project: '/work/app' });
  store.applyTriage([{ id: 3, verdict: 'do', impact: 4, size: 's', model: 'haiku', title: 'Tor relay', why: 'w', brief: 'b' }]);
  store.updateIdea(3, { status: 'doing' });
  const { data, note } = await publish.build(store.load());
  assert.equal(note, '');
  assert.equal(data.version, 1);
  assert.equal(data.embed.available, true);
  assert.equal(data.embed.query_prefix, 'search_query: ');
  assert.equal(data.counts.doing, 1);
  const [one, two, three] = data.ideas;
  assert.deepEqual([one.key, one.lane, one.project, three.lane, three.model], ['IDEA-1', 'inbox', 'app', 'doing', 'haiku']);
  assert.deepEqual(data.ideas.map((i) => i.rank), [2, 1, 0]); // doing first, then the inbox, newest first
  assert.deepEqual(data.groups, [{ id: 0, label: data.groups[0].label, ids: [1, 2] }]);
  assert.deepEqual([one.group, two.group, three.group], [0, 0, null]);
  assert.equal(one.related[0].id, 2);
  assert.ok(three.phases.some((p) => p.phase === 'doing' && p.from === three.started));
  const vectors = await embed.vectorsFor(store.load().ideas);
  assert.deepEqual([...embed.decodeVec(one.vec)], [...vectors.get(1)]);
});

test('without the embedding server, the snapshot has no groups or vectors, and says why', async () => {
  store.addIdeas(['one idea']);
  server.options.down = true;
  const { data, note } = await publish.build(store.load());
  assert.match(note, /without search by meaning or groups: .*503/);
  assert.equal(data.embed.available, false);
  assert.deepEqual([data.groups, data.ideas[0].vec, data.ideas[0].related], [[], null, []]);
});

test('publish uploads data.json and index.html with PUT, and kick() starts again only after a change', async () => {
  store.addIdeas(['one idea']);
  let started = 0;
  const kick = () => publish.kick({ start: () => started++ });
  assert.equal(kick(), false); // no dashboard server set
  config.set('publish_url', `${server.url}/dash`);
  assert.equal(kick(), true); // never published
  const out = await publish.publish();
  assert.deepEqual([out.where, out.ideas], [`${server.url}/dash`, 1]);
  assert.deepEqual([...server.files.keys()], ['/dash/data.json', '/dash/index.html']);
  assert.equal(JSON.parse(server.files.get('/dash/data.json')).ideas[0].title, 'one idea');
  assert.match(server.files.get('/dash/index.html'), /<html/i);
  assert.equal(kick(), false); // nothing changed
  await new Promise((resolve) => setTimeout(resolve, 20)); // a later modification time
  store.addIdeas(['two']);
  assert.equal(kick(), true);
  assert.equal(started, 2);
});

test('a failed background publish is recorded, and kick() waits before the next try', async () => {
  store.addIdeas(['one idea']);
  const closed = await startFakeServer();
  await closed.close();
  config.set('publish_url', `${closed.url}/`);
  assert.equal(await publish.backgroundPublish(), 'error');
  assert.match(publish.readState().error, /cannot reach/);
  assert.equal(publish.kick({ start: () => assert.fail('must wait') }), false);
  assert.match(publish.status(), /failed/);
});

test('publish --dir writes both files to a folder', async () => {
  store.addIdeas(['one idea']);
  const dir = path.join(store.home(), 'out');
  const out = await publish.publish({ dir });
  assert.equal(out.where, dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['data.json', 'index.html']);
});

test('config: the environment wins over the file, and an empty value restores the default', () => {
  assert.equal(config.get('search_threshold'), 0.5);
  assert.equal(config.set('search_threshold', '0.42'), 0.42);
  process.env.IDEAMINE_SEARCH_THRESHOLD = '0.9';
  assert.equal(config.get('search_threshold'), 0.9);
  delete process.env.IDEAMINE_SEARCH_THRESHOLD;
  assert.equal(config.set('search_threshold', ''), 0.5);
  assert.throws(() => config.set('search_threshold', '2'), /from 0 to 1/);
  assert.throws(() => config.get('nope'), /unknown setting/);
  assert.match(config.describe(), /^embed_url\s+http:\/\/127\.0\.0\.1:\d+\/v1\s+IDEAMINE_EMBED_URL/);
});

// ---- the Flow view: lane over time, cumulative flow, and the tiles ----

const iso = (ms) => new Date(ms).toISOString();
const NOW = 4_000_000;

/** An idea with ordered times: created ≤ triaged ≤ started ≤ closed, each stage optional. */
const ideaArb = fc
  .record({
    id: fc.integer({ min: 1, max: 1000 }),
    created: fc.integer({ min: 0, max: 1_000_000 }),
    gaps: fc.tuple(fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 500_000 })),
    stage: fc.constantFrom('inbox', 'triaged', 'doing', 'done', 'dropped'),
    triaged: fc.boolean(),
    hasStart: fc.boolean(),
    verdict: fc.constantFrom('do', 'maybe', 'skip'),
  })
  .map(({ id, created, gaps, stage, triaged, hasStart, verdict }) => {
    const idea = { id, created: iso(created), status: stage === 'triaged' ? 'triaged' : stage, updated: iso(created) };
    let t = created;
    if (stage === 'triaged' || (triaged && stage !== 'inbox')) idea.triage = { at: iso((t += gaps[0])), verdict };
    if (hasStart && ['doing', 'done', 'dropped'].includes(stage)) idea.started = iso((t += gaps[1]));
    if (stage === 'done' || stage === 'dropped') idea.closed = iso((t += gaps[2]));
    idea.updated = iso(t);
    return idea;
  });

test('laneAt() agrees with lane() once every time is in the past, and is null before the idea exists', () => {
  fc.assert(
    fc.property(ideaArb, (idea) => {
      assert.equal(publish.laneAt(idea, NOW), store.lane(idea));
      assert.equal(publish.laneAt(idea, Date.parse(idea.created) - 1), null);
      assert.notEqual(publish.laneAt(idea, Date.parse(idea.created)), null);
    }),
  );
});

test('laneAt() walks the stages in order', () => {
  const idea = { id: 1, created: T(1), status: 'done', triage: { at: T(2), verdict: 'do' }, started: T(3), closed: T(5) };
  const at = (h) => publish.laneAt(idea, Date.parse(T(h)));
  assert.deepEqual([at(0), at(1), at(2), at(3), at(4), at(5), at(9)], [null, 'inbox', 'do', 'doing', 'doing', 'done', 'done']);
  // In work before ideamine recorded start times: the work is estimated from the triage, like phases().
  assert.equal(publish.laneAt({ id: 2, created: T(1), status: 'doing', triage: { at: T(2), verdict: 'do' } }, Date.parse(T(3))), 'doing');
  assert.equal(publish.laneAt({ id: 2, created: T(1), status: 'doing', triage: { at: T(2), verdict: 'do' } }, Date.parse(T(1))), 'inbox');
});

test('flow(): at every sample, the lanes add up to the ideas that existed then', () => {
  fc.assert(
    fc.property(fc.array(ideaArb, { minLength: 0, maxLength: 30 }), fc.integer({ min: 2, max: 80 }), (ideas, samples) => {
      const { times, series } = publish.flow(ideas, { samples, now: NOW });
      assert.deepEqual(Object.keys(series).sort(), [...store.LANES].sort());
      for (const lane of store.LANES) assert.equal(series[lane].length, times.length);
      if (!ideas.length) return assert.equal(times.length, 0);
      assert.ok(times.length >= 2 && times.length <= samples);
      assert.equal(times[times.length - 1], iso(NOW));
      for (let k = 0; k < times.length; k++) {
        const t = Date.parse(times[k]);
        if (k > 0) assert.ok(t > Date.parse(times[k - 1]), 'times are strictly increasing');
        const total = store.LANES.reduce((sum, lane) => sum + series[lane][k], 0);
        assert.equal(total, ideas.filter((i) => Date.parse(i.created) <= t).length);
      }
    }),
  );
});

test('stats(): open count, the last 7 days, medians, the oldest open idea, and the model mix', () => {
  const now = Date.parse('2026-09-22T00:00:00.000Z');
  const day = (n, h = 0) => new Date(now - n * 86400000 + h * 3600000).toISOString();
  const ideas = [
    { id: 1, created: day(10), status: 'inbox' },
    { id: 2, created: day(9), status: 'triaged', triage: { at: day(8), verdict: 'do', model: 'haiku', size: 's' } },
    { id: 3, created: day(9), status: 'triaged', triage: { at: day(8), verdict: 'skip', model: 'opus', size: 'l' } },
    { id: 4, created: day(6), status: 'doing', triage: { at: day(5), verdict: 'do', model: 'sonnet', size: 'm' }, started: day(4) },
    { id: 5, created: day(8), status: 'done', started: day(3), closed: day(1) },
    { id: 6, created: day(30), status: 'done', started: day(20), closed: day(10) },
    { id: 7, created: day(2), status: 'dropped', closed: day(1) },
  ];
  const s = publish.stats(ideas, { now });
  assert.equal(s.open, 3); // #1 inbox, #2 do, #4 doing
  assert.deepEqual([s.done_7d, s.dropped_7d], [1, 1]);
  assert.equal(s.lead_median_ms, (7 + 20) / 2 * 86400000); // #5: 7 days, #6: 20 days
  assert.equal(s.cycle_median_ms, (2 + 10) / 2 * 86400000);
  assert.equal(s.oldest_open_ms, 10 * 86400000);
  assert.deepEqual(s.models, { haiku: 1, sonnet: 1, opus: 0, fable: 0 });
  assert.deepEqual(s.sizes, { xs: 0, s: 1, m: 1, l: 0, xl: 0 });
  const empty = publish.stats([], { now });
  assert.deepEqual([empty.open, empty.lead_median_ms, empty.cycle_median_ms, empty.oldest_open_ms], [0, null, null, null]);
});

test('the snapshot carries the flow series and the stats', async () => {
  store.addIdeas(['one idea']);
  const { data } = await publish.build(store.load());
  assert.equal(data.flow.times.length, data.flow.series.inbox.length);
  assert.equal(data.flow.series.inbox.at(-1), 1);
  assert.equal(data.stats.open, 1);
});
