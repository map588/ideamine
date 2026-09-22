// UserPromptSubmit hook: answers /idea, /ideas, and the local /ideas-* commands (ls, cat, rm, done,
// reopen, find, groups, watch, web) and blocks the prompt, so the model is never called. That makes
// capture free, instant, and possible even when the session is out of usage. Every other prompt
// passes through untouched, including /ideas-go, /ideas-all, /ideas-sort, and questions, which their
// skills answer. After each prompt, the hook lets the watcher and the dashboard catch up.

import * as embed from './embed.js';
import * as publish from './publish.js';
import { renderAdded, renderBoard, renderFound, renderGroups, renderIdea } from './render.js';
import * as serve from './serve.js';
import { addIdeas, FILTERS, findIdea, lane, listIdeas, load, removeIdeas, updateIdea } from './store.js';
import { clip, splitIdeas } from './text.js';
import * as watch from './watch.js';

// `/idea ...`, `/ideas ...`, `/ideas-<verb> ...`, and the plugin-qualified `/ideamine:...` forms.
// Each verb is a separate skill with a dash, so that the slash menu shows it.
const COMMAND = /^\s*\/(?:ideamine:)?(idea|ideas(?:-[a-z]+)?)(?=\s|$)([\s\S]*)$/i;
const STATUS_COMMANDS = { 'ideas-done': 'done', 'ideas-reopen': 'reopen' };
const ID = /^#?\d+$/;

const USAGE = `Usage: /idea <text>                add an idea (a bulleted list adds one idea per bullet)
       /ideas [question]            show the queue, or ask about your ideas
       /ideas-ls [lane|-a] [here]   list. Lanes: inbox do maybe skip doing done dropped
       /ideas-cat N...              show ideas in full
       /ideas-rm N...               delete ideas for good
       /ideas-done N [note] · /ideas-reopen N
       /ideas-find <words>          search by meaning (all lanes)
       /ideas-groups [lane|-a]      ideas grouped by meaning
These call the model:
       /ideas-go [N]                build the next idea, or #N, on its model. New ideas are triaged first.
       /ideas-pipeline [N]          the same, through the agent pipeline (agent-pipeline plugin), for big ideas
       /ideas-all                   do every idea that fits this chat. The others stay in the queue.
       /ideas-sort                  triage the inbox now and show the queue
       /ideas-watch [off]           Haiku triages new ideas and pairs them with projects, in the background
Local, in your browser:
       /ideas-web [off]             the dashboard on this machine: board, timeline, table, projects, flow, matrix, groups`;

const noIdea = (ids) => `No idea ${ids.map((id) => `#${String(id).replace(/^#/, '')}`).join(', ')}.`;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// A search by meaning must not hold the prompt for long when the embedding server is away.
const SEARCH_TIMEOUT_MS = 4000;

/** Handle one prompt. Resolves to the text to show the user, or null to let the prompt through. */
export async function handlePrompt(prompt, { cwd = process.cwd(), session = null } = {}) {
  const m = COMMAND.exec(prompt || '');
  if (!m) return null;
  const command = m[1].toLowerCase();
  const arg = m[2].trim();

  if (command === 'idea') {
    if (!arg) return USAGE;
    const results = addIdeas(splitIdeas(arg), { source: 'hook', project: cwd, session });
    return renderAdded(results, load());
  }

  if (command === 'ideas-watch') {
    if (!arg) watch.turnOn();
    else if (/^off$/i.test(arg)) watch.turnOff();
    else return null;
    return watch.status(); // runHook starts the first pass after this
  }

  if (command === 'ideas-web') {
    if (/^off$/i.test(arg)) return serve.stop();
    if (arg) return null;
    const message = serve.ensureRunning();
    serve.openBrowser(serve.running()?.url || `http://127.0.0.1:${serve.DEFAULT_PORT}/`);
    return message;
  }

  const words = arg.split(/\s+/).filter(Boolean);
  const ids = words.length > 0 && words.every((w) => ID.test(w)) ? words : null;
  const db = load();

  if (command === 'ideas' && !words.length) return renderBoard(db, { cwd, hints: true });

  if (command === 'ideas-find') {
    if (!arg) return USAGE;
    return renderFound(await embed.find(db, arg, { timeoutMs: SEARCH_TIMEOUT_MS }), arg, { cwd });
  }

  if (command === 'ideas-groups') {
    const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
    if (lower.length <= 1 && lower.every((w) => FILTERS.includes(w))) {
      const filter = lower[0] || 'open';
      const ideas = listIdeas(db, { filter });
      try {
        const groups = await embed.groupIdeas(ideas, { timeoutMs: SEARCH_TIMEOUT_MS });
        return renderGroups(groups, ideas, { cwd, scope: filter });
      } catch (e) {
        if (!(e instanceof embed.EmbedError)) throw e;
        return `Groups need the embedding server, which does not answer: ${e.message}`;
      }
    }
  }

  if (command === 'ideas-ls') {
    const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
    const filters = lower.filter((w) => FILTERS.includes(w));
    const here = lower.includes('here');
    if (filters.length + (here ? 1 : 0) === lower.length && filters.length <= 1) {
      return renderBoard(db, { filter: filters[0] || 'open', project: here ? cwd : null, cwd, hints: true });
    }
  }

  if ((command === 'ideas-cat' || command === 'ideas-rm') && ids) {
    const missing = ids.filter((id) => !findIdea(db, id));
    if (missing.length) return noIdea(missing);
    if (command === 'ideas-cat') return ids.map((id) => renderIdea(findIdea(db, id))).join('\n\n');
    return removeIdeas(ids).map((i) => `✗ Removed #${i.id} · ${clip(i.title, 60)}`).join('\n');
  }

  const status = STATUS_COMMANDS[command];
  if (status && words[0] && ID.test(words[0])) {
    if (!findIdea(db, words[0])) return noIdea([words[0]]);
    const note = words.slice(1).join(' ');
    const idea = updateIdea(words[0], { status, note: note || undefined });
    return `✓ #${idea.id} ${clip(idea.title, 60)} → ${lane(idea)}${note ? ' (note added)' : ''}`;
  }

  return null; // a question, /ideas-go, -all, -sort, or other words: the skill answers with the model
}

export async function runHook() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not a hook payload; stay out of the way
  }
  let message = null;
  try {
    message = await handlePrompt(typeof input?.prompt === 'string' ? input.prompt : '', {
      cwd: input.cwd || process.cwd(),
      session: input.session_id || null,
    });
  } catch (e) {
    // Never swallow the user's text: let the prompt through so the /idea skill can save it via MCP.
    process.stderr.write(`ideamine: ${e.message}\n`);
  }
  if (message != null) {
    // Blocking ends the turn before any API request. suppressOriginalPrompt keeps Claude Code from
    // echoing the command back under our message.
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: message,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    }));
  }
  // Each prompt lets the watcher and the dashboard catch up, so they keep going while they are on.
  for (const kick of [watch.kick, publish.kick]) {
    try {
      kick();
    } catch {
      // The watcher and the dashboard must never stop a prompt.
    }
  }
}
