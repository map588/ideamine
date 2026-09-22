// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies, so the plugin
// runs straight from a git checkout with nothing to install.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { headlessTriage, triageFirst } from './claude.js';
import * as embed from './embed.js';
import { knownProjects } from './projects.js';
import { renderAdded, renderBoard, renderFound, renderGroups, renderIdea } from './render.js';
import { BATCH_SCHEMA, MODELS, pendingIdeas, triagePrompt } from './rubric.js';
import {
  addIdeas,
  applyTriage,
  counts,
  FILTERS,
  findIdea,
  lane,
  listIdeas,
  load,
  pickNext,
  removeIdeas,
  STATUSES,
  updateIdea,
} from './store.js';
import { clip, splitIdeas } from './text.js';

const ROOT = new URL('..', import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(new URL('package.json', ROOT), 'utf8')).version;
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'ideamine is the user\'s idea archive, shared by every session, project, and model. When the user tosses out an ' +
  'idea for later ("idea: ...", "save this idea", "someday we should ..."), save it with idea_add and continue the ' +
  'current task. Do not start building a saved idea unless the user asks.';

const currentProject = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

const MODEL_ENUM = MODELS.map((m) => m.alias);

const TOOLS = [
  {
    name: 'idea_add',
    description:
      'Save an idea to the ideamine archive. Use when the user shares an idea to keep for later. Only save it: ' +
      'do not plan or build it, and continue what you were doing. A bulleted list becomes one idea per bullet.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The idea, verbatim.' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string', description: 'Project directory the idea belongs to. Default: current project.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { title: 'Save idea', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'idea_list',
    description:
      'Show the idea board, or one idea in full when id is given. full=true shows every listed idea in full. ' +
      'semantic=true ranks ideas by meaning for the query. groups=true groups the listed ideas by meaning.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Show this idea in full.' },
        filter: { type: 'string', enum: FILTERS, description: 'Default: open (doing, do, maybe, inbox).' },
        query: { type: 'string', description: 'Only ideas containing all of these words (with semantic: ideas like it).' },
        semantic: { type: 'boolean', description: 'Rank by meaning (nomic-embed-text), best first. Falls back to words.' },
        groups: { type: 'boolean', description: 'Group the listed ideas by meaning.' },
        here: { type: 'boolean', description: 'Only ideas from the current project.' },
        limit: { type: 'integer' },
        full: { type: 'boolean', description: 'Every listed idea in full (brief, text, notes), not one line each.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List ideas', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'idea_triage',
    description:
      'Triage ideas: decide which are worth doing and the cheapest model that can build each. headless=true ' +
      'does it in a separate minimal Claude Code call (cheapest; your context is not used). Otherwise call with ' +
      'no verdicts to get the rubric and the untriaged ideas, then call once more with all verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Triage the inbox in a separate low-cost `claude -p` call.' },
        model: { type: 'string', enum: MODEL_ENUM, description: 'Model for headless triage (default sonnet).' },
        verdicts: BATCH_SCHEMA.properties.verdicts,
        ids: { type: 'array', items: { type: 'integer' }, description: 'Re-triage these ideas instead of the inbox.' },
        limit: { type: 'integer', description: 'Max ideas (default 20 headless, 30 otherwise).' },
        by: { type: 'string', description: 'Your model name, recorded with the verdicts.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Triage ideas', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'idea_update',
    description: 'Change an idea: status, text, title, tags, model override, project, or append a note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: [...STATUSES, 'reopen'] },
        note: { type: 'string', description: 'Appended to the idea\'s notes, e.g. the outcome.' },
        title: { type: 'string' },
        text: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        model: { type: 'string', enum: MODEL_ENUM },
        project: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Update idea', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'idea_next',
    description:
      'Pick the idea to build next (verdict "do" before "maybe", current project first, then best value per ' +
      'effort), or fetch one by id. Returns its brief, project, and the model recommended to build it. Without ' +
      'id, it also returns the whole queue. triage=true first triages the untriaged candidates (the inbox, or ' +
      'the given id) in one headless call.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        here: { type: 'boolean', description: 'Only consider ideas from the current project.' },
        triage: { type: 'boolean', description: 'Triage untriaged candidates first, so the pick and the model are current.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Next idea', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'idea_remove',
    description:
      'Take ideas out of the queue: delete them from the archive for good, and return each one in full. ' +
      'An unknown id is an error, and then nothing is deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, description: 'The ideas to delete.' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    annotations: { title: 'Remove ideas', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

// Slash commands for clients that load this server without the plugin (the plugin ships skills instead).
// The prompt text is the matching SKILL.md body, so both stay in sync.
const PROMPTS = [
  { name: 'idea', description: 'Save an idea for later', arguments: [{ name: 'text', required: true }] },
  { name: 'ideas', description: 'Show the queue, or ask about your ideas', arguments: [{ name: 'question', required: false }] },
  { name: 'ideas-ls', description: 'List the queue, one lane, or every lane (-a)', arguments: [{ name: 'lane', required: false }] },
  { name: 'ideas-cat', description: 'Show ideas in full', arguments: [{ name: 'ids', required: true }] },
  { name: 'ideas-rm', description: 'Delete ideas for good', arguments: [{ name: 'ids', required: true }] },
  { name: 'ideas-find', description: 'Search ideas by meaning', arguments: [{ name: 'words', required: true }] },
  { name: 'ideas-groups', description: 'Show ideas grouped by meaning', arguments: [{ name: 'lane', required: false }] },
  { name: 'ideas-done', description: 'Mark an idea done', arguments: [{ name: 'id', required: true }, { name: 'note', required: false }] },
  { name: 'ideas-reopen', description: 'Put an idea back in the queue', arguments: [{ name: 'id', required: true }] },
  { name: 'ideas-go', description: 'Build the next idea on its recommended model', arguments: [{ name: 'id', required: false }] },
  { name: 'ideas-pipeline', description: 'Build the next idea through the agent pipeline', arguments: [{ name: 'id', required: false }] },
  { name: 'ideas-all', description: 'Do every idea that fits this chat', arguments: [] },
  { name: 'ideas-sort', description: 'Triage the inbox now and show the queue', arguments: [] },
  { name: 'ideas-watch', description: 'Turn the background watcher on or off', arguments: [{ name: 'off', required: false }] },
  { name: 'ideas-web', description: 'Open the dashboard in your browser, served on this machine', arguments: [{ name: 'off', required: false }] },
];

function skillBody(name, args) {
  const file = new URL(`skills/${name}/SKILL.md`, ROOT);
  const text = fs.readFileSync(fileURLToPath(file), 'utf8').replace(/^---[\s\S]*?\n---\s*\n/, '');
  return text.replaceAll('$ARGUMENTS', args || '').trim();
}

function summarizeTriage(results, how = '') {
  const ok = results.filter((r) => !r.error);
  const tally = ['do', 'maybe', 'skip'].map((v) => `${ok.filter((r) => r.verdict === v).length} ${v}`).join(' · ');
  const lines = [`Saved ${ok.length} verdict${ok.length === 1 ? '' : 's'}: ${tally}${how ? ` (${how})` : ''}`];
  for (const r of ok) {
    const meta = r.verdict === 'skip' ? '' : ` · ${r.model} · ${r.size.toUpperCase()}`;
    lines.push(`  #${r.id} ${r.verdict}${meta}  ${clip(r.title, 60)}${r.moved ? `  → ${path.basename(r.moved)}` : ''}`);
  }
  for (const r of results.filter((x) => x.error)) lines.push(`  #${r.id} not saved: ${r.error}`);
  const left = counts(load()).inbox;
  if (left) lines.push(`${left} still in inbox.`);
  return lines.join('\n');
}

function headlessSummary(out) {
  return out.message || summarizeTriage(out.results, `${out.model}, ${out.tokens.input} in / ${out.tokens.output} out tokens`);
}

/** The board after a triage, so the user sees every idea in its new place. */
function withBoard(text) {
  return `${text}\n\n${renderBoard(load(), { cwd: currentProject(), hints: true })}`;
}

// ---------------------------------------------------------------------------------------------
// Tool handlers return plain text for the model.

const handlers = {
  idea_add({ text, tags, project }) {
    const results = addIdeas(splitIdeas(text || ''), { source: 'mcp', project: project || currentProject(), tags });
    return renderAdded(results, load());
  },

  async idea_list({ id, filter = 'open', query = '', here = false, limit = 0, full = false, semantic = false, groups = false }) {
    const db = load();
    if (id != null) {
      const idea = findIdea(db, id);
      if (!idea) throw new Error(`no idea #${id}`);
      return renderIdea(idea);
    }
    const project = here ? currentProject() : null;
    if (semantic && query) {
      const found = await embed.find(db, query, { filter, project, limit: limit || 10 });
      if (!full) return renderFound(found, query, { cwd: currentProject() });
      return found.results.length ? found.results.map((r) => renderIdea(r.idea)).join('\n\n') : 'No ideas match.';
    }
    if (groups) {
      const ideas = listIdeas(db, { filter, query, limit, project });
      return renderGroups(await embed.groupIdeas(ideas), ideas, { cwd: currentProject(), scope: filter });
    }
    if (full) {
      const ideas = listIdeas(db, { filter, query, limit, project });
      return ideas.length ? ideas.map(renderIdea).join('\n\n') : 'No ideas match.';
    }
    return renderBoard(db, { filter, query, limit, project, cwd: currentProject() });
  },

  async idea_triage({ verdicts, ids, limit, by, headless = false, model }) {
    if (headless) {
      return withBoard(headlessSummary(await headlessTriage({ model, limit: limit || 20 })));
    }
    if (Array.isArray(verdicts) && verdicts.length) {
      const projects = knownProjects(load());
      return withBoard(summarizeTriage(applyTriage(verdicts, { by: by ? clip(by, 40) : 'claude', projects })));
    }
    limit ||= 30;
    const db = load();
    const pending = pendingIdeas(db, { ids, limit });
    if (!pending.length) return 'Nothing to triage: the inbox is empty.';
    return (
      triagePrompt(db, pending, knownProjects(db)) +
      '\n\nSave every verdict in ONE idea_triage call: ' +
      '{"verdicts":[{"id":1,"verdict":"do","impact":3,"size":"s","model":"sonnet","title":"...","why":"...","brief":"...","project":"..."}]}'
    );
  },

  idea_update({ id, ...patch }) {
    const idea = updateIdea(id, patch);
    const bits = [`#${idea.id} ${clip(idea.title, 60)} · ${lane(idea)}`];
    if (patch.model) bits.push(`model ${idea.triage.model}`);
    if (patch.note) bits.push('note added');
    return `Updated ${bits.join(' · ')}`;
  },

  async idea_next({ id, here = false, triage = false }) {
    const out = [];
    if (triage) {
      try {
        const res = await triageFirst({ id });
        if (res) out.push(headlessSummary(res));
      } catch (e) {
        out.push(`Triage failed: ${e.message}`);
      }
    }
    const db = load();
    let idea;
    if (id != null) {
      idea = findIdea(db, id);
      if (!idea) throw new Error(`no idea #${id}`);
    } else {
      idea = pickNext(db, { project: currentProject(), only: here });
    }
    if (!idea) {
      const c = counts(db);
      out.push(
        c.inbox
          ? `No idea is ready: ${c.inbox} untriaged in the inbox.${triage ? '' : ' Pass triage: true to triage them first.'}`
          : `The queue is empty${here ? ' for this project' : ''}.`,
      );
      return out.join('\n\n');
    }
    const t = idea.triage;
    const lines = [renderIdea(idea), ''];
    if (!t) lines.push('recommended model: none yet (untriaged)');
    else lines.push(`recommended model: ${t.model}`);
    // Ideas are saved from any session, so the recorded folder can be a scratch folder that is gone.
    const dir = idea.project;
    lines.push(`project dir: ${dir ? `${dir} (${fs.existsSync(dir) ? 'exists' : 'does not exist'})` : '(none recorded)'}`);
    out.push(lines.join('\n'));
    // The whole queue, so the caller can choose an idea that fits its chat better than the first one.
    if (id == null) out.push(`The queue:\n${renderBoard(db, { cwd: currentProject() })}`);
    return out.join('\n\n');
  },

  idea_remove({ ids = [] }) {
    if (!ids.length) throw new Error('pass the ids to delete');
    const gone = removeIdeas(ids);
    return [`Removed ${gone.length} idea${gone.length === 1 ? '' : 's'}.`, ...gone.map(renderIdea)].join('\n\n');
  },
};

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(msg, { prompts }) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      const capabilities = { tools: { listChanged: false } };
      if (prompts) capabilities.prompts = { listChanged: false };
      return result(id, { protocolVersion, capabilities, serverInfo: { name: 'ideamine', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const handler = handlers[params.name];
      if (!handler) return error(id, -32602, `unknown tool: ${params.name}`);
      try {
        const text = await handler(params.arguments || {});
        return result(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return result(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    case 'prompts/list':
      return result(id, { prompts: prompts ? PROMPTS : [] });
    case 'prompts/get': {
      const p = prompts && PROMPTS.find((x) => x.name === params.name);
      if (!p) return error(id, -32602, `unknown prompt: ${params.name}`);
      const args = Object.values(params.arguments || {}).filter(Boolean).join(' ');
      return result(id, {
        description: p.description,
        messages: [{ role: 'user', content: { type: 'text', text: skillBody(p.name, args) } }],
      });
    }
    case 'resources/list':
      return result(id, { resources: [] });
    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });
    case 'logging/setLevel':
      return result(id, {});
    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}

async function handleMessage(msg, opts) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return error(null, -32600, 'invalid request');
  if (typeof msg.method !== 'string') return null; // a response to a request we never send
  if (msg.id === undefined) return null; // notification (initialized, cancelled, ...)
  try {
    return await handleRequest(msg, opts);
  } catch (e) {
    return error(msg.id, -32603, e.message);
  }
}

async function handleLine(line, opts) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return error(null, -32700, 'parse error');
  }
  if (!Array.isArray(msg)) return handleMessage(msg, opts);
  const replies = (await Promise.all(msg.map((m) => handleMessage(m, opts)))).filter(Boolean);
  return replies.length ? replies : null;
}

/** Serve MCP on stdin/stdout. `prompts: false` when running as a plugin (skills cover slash commands). */
export function serve({ prompts = true } = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  // Requests run concurrently (a headless triage must not stall a ping); replies carry their ids.
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const job = handleLine(line, { prompts }).then((reply) => reply && send(reply));
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
  });
  rl.on('close', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
}
