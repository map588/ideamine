import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, pipelinePrompt } from '../src/claude.js';

const idea = { id: 12, title: 'Sync subtitles', text: 'sync subtitles with the audiobook', triage: { brief: 'Align the text with the audio track.' } };

test('the pipeline request names the idea, its project, and its id, so the pipeline can report on it', () => {
  const prompt = pipelinePrompt(idea, { dir: '/work/app' });
  assert.equal(prompt, [
    '/pipeline Build idea #12 from my ideamine archive: Sync subtitles',
    'Align the text with the audio track.',
    'My original note: sync subtitles with the audiobook',
    'Project: /work/app',
    'ideamine idea id: 12',
  ].join('\n'));
  assert.match(pipelinePrompt({ ...idea, triage: null }, { dir: '/x' }), /^\/pipeline Build idea #12[^]*\nMy original note: /);
  assert.doesNotMatch(buildPrompt(idea), /^\/pipeline/); // /ideas-go keeps its one-agent prompt
});
