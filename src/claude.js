// Running the Claude Code CLI from ideamine: headless triage, and launching a session to build an idea.

import { spawn, spawnSync } from 'node:child_process';
import { knownProjects } from './projects.js';
import { BATCH_SCHEMA, pendingIdeas, triagePrompt } from './rubric.js';
import { applyTriage, counts, findIdea, load, normalizeModel } from './store.js';

/** Claude Code executable: explicit override, else the one running us (desktop app), else PATH. */
export function claudeBin() {
  return process.env.IDEAMINE_CLAUDE_BIN || process.env.CLAUDE_CODE_EXECPATH || 'claude';
}

function command(args) {
  const bin = claudeBin();
  // A .js file is run with node, which keeps a stand-in CLI portable (used by the tests).
  return /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

/**
 * Environment for a separate, independent Claude Code process: drop the variables that tie a
 * child to the session that started us (nesting guard, host messaging, the parent's effort).
 */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'CLAUDECODE' ||
      key === 'CLAUDE_PID' ||
      key === 'CLAUDE_EFFORT' ||
      key === 'AI_AGENT' ||
      /^CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|HOST_SESSION_ID|SESSION_ID|SESSION_ATTENDED|MESSAGING_.*|SDK_.*|EXECPATH)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

function parseLooseJson(text) {
  const s = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function run(args, input, timeoutMs, env = {}) {
  const [bin, argv] = command(args);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { env: { ...childEnv(), ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`Claude Code CLI not found ("${bin}"). Install it or set IDEAMINE_CLAUDE_BIN.`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/**
 * Triage the inbox with a one-shot `claude -p` call: no tools, no MCP servers, no settings, a
 * two-line system prompt, and JSON-schema output. Runs on the user's normal Claude Code login and
 * costs about 400 tokens per idea, whatever model the calling session uses. `ids` triages those
 * ideas instead of the inbox. The triage also pairs each idea with a project folder of this machine.
 */
export async function headlessTriage({ model = process.env.IDEAMINE_TRIAGE_MODEL || 'sonnet', ids = null, limit = 20, dryRun = false, budget = 1 } = {}) {
  const alias = normalizeModel(model) || model;
  const db = load();
  const pending = pendingIdeas(db, { ids, limit });
  if (!pending.length) return { message: 'Nothing to triage: the inbox is empty.' };

  const projects = knownProjects(db);
  const prompt = `${triagePrompt(db, pending, projects)}\n\nReturn one verdict for every idea listed above.`;
  // Skipping settings drops hooks, plugins, and skill listings: ~4k fewer input tokens per call.
  // Set IDEAMINE_SETTING_SOURCES=user if your login depends on settings.json (apiKeyHelper, env).
  const args = [
    '-p',
    '--model', alias,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(BATCH_SCHEMA),
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', process.env.IDEAMINE_SETTING_SOURCES ?? '',
    '--no-session-persistence',
    '--max-budget-usd', String(budget),
    '--system-prompt', 'You triage a developer\'s backlog of ideas. Follow the rubric exactly and answer only with the requested JSON.',
  ];
  if (alias !== 'haiku') args.push('--effort', 'low');
  // Haiku takes no effort setting. Its thinking was about 70% of its output tokens and did not change
  // the verdicts, so it gets no thinking.
  const env = alias === 'haiku' ? { MAX_THINKING_TOKENS: '0' } : {};
  if (dryRun) {
    const shown = args.map((a) => (/[\s"{]/.test(a) || !a ? JSON.stringify(a) : a)).join(' ');
    const vars = Object.entries(env).map(([k, v]) => `${k}=${v} `).join('');
    return { message: `${vars}${claudeBin()} ${shown}\n\n${prompt}` };
  }

  const res = await run(args, prompt, 5 * 60 * 1000, env);
  let out;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n');
    throw new Error(`claude exited with code ${res.code}: ${detail || 'no output'}`);
  }
  if (out.is_error) throw new Error(`claude: ${out.result || out.subtype || 'error'}`);
  const data = out.structured_output ?? parseLooseJson(out.result);
  if (!Array.isArray(data?.verdicts)) throw new Error('claude answered without verdicts');
  const results = applyTriage(data.verdicts, { by: `${alias} (headless)`, projects });
  const u = out.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return { results, model: alias, cost: out.total_cost_usd, tokens: { input, output: u.output_tokens || 0 } };
}

/**
 * The triage that /ideas-go needs before it picks: the idea `id` when it has no verdict, else the
 * whole inbox. Returns the headlessTriage result, or null when every candidate has a verdict already.
 */
export async function triageFirst({ id = null, model } = {}) {
  const db = load();
  if (id != null) {
    const idea = findIdea(db, id);
    return idea && !idea.triage ? headlessTriage({ model, ids: [idea.id] }) : null;
  }
  return counts(db).inbox ? headlessTriage({ model }) : null;
}

/** The opening prompt for a fresh session that builds one idea. */
export function buildPrompt(idea) {
  const t = idea.triage;
  const lines = [`Build idea #${idea.id} from my ideamine archive: ${idea.title}`, ''];
  if (t?.brief) lines.push(t.brief, '');
  lines.push('My original note:', idea.text, '');
  lines.push(
    `When you finish, record the outcome with the ideamine idea_update tool (id ${idea.id}, status "done", a one-line note), ` +
      `or run: ideamine done ${idea.id} "<one-line outcome>"`,
  );
  return lines.join('\n');
}

/**
 * The request for the agent pipeline (the `pipeline` skill of the agent-pipeline plugin): the idea,
 * its project, and how to record the progress on the idea. The pipeline does not know ideamine,
 * so the request carries the instructions.
 */
export function pipelinePrompt(idea, { dir }) {
  const t = idea.triage;
  const lines = [`/pipeline Build idea #${idea.id} from my ideamine archive: ${idea.title}`];
  if (t?.brief) lines.push(t.brief);
  lines.push(`My original note: ${idea.text}`, `Project: ${dir}`, '', ...progressInstructions(idea.id));
  return lines.join('\n');
}

/** What the pipeline orchestrator does with the idea after each phase. Shared with the /ideas-pipeline skill. */
export function progressInstructions(id) {
  return [
    `Progress: ideamine idea #${id} is the record of this run. After each phase and each gate, add one note to it: ` +
      `run \`ideamine note ${id} "pipeline: <phase>"\`, or call the ideamine idea_update tool with id ${id} and the note. ` +
      'Use notes like "pipeline: research done", "pipeline: storyboard approved", "pipeline: plan approved (3 tasks, 2 waves)", ' +
      '"pipeline: wave 1 integrated", "pipeline: round 1 failed: <one line>".',
    `When the tester and the validator both pass, run \`ideamine done ${id} "<one-line outcome>"\` (or idea_update with status "done"). ` +
      'If the run stops at its iteration cap or escalates, leave the idea in "doing" and add a note that says what failed and where the reports are.',
  ];
}

/** Start an interactive Claude Code session on the recommended model. */
export function launchSession({ model, prompt, cwd }) {
  const [bin, argv] = command(['--model', model, prompt]);
  const res = spawnSync(bin, argv, { cwd, stdio: 'inherit', env: childEnv() });
  if (res.error) throw res.error;
  return res.status ?? 0;
}
