#!/usr/bin/env node
// ideamine CLI. Also the entry point the plugin uses for its MCP server (`mcp`) and hook (`hook`).

import fs from 'node:fs';

const HELP = `ideamine: an idea inbox for Claude Code

  ideamine add <idea...>          save an idea ("-" reads stdin; a bulleted list = one idea per bullet)
  ideamine ls [lane|-a] [here]    the queue. lanes: open inbox do maybe skip doing done dropped all
  ideamine cat <id...>            ideas in full
  ideamine rm <id...>             delete ideas for good
  ideamine done|drop|start|reopen <id> [note...]
  ideamine note <id> <text...>    append a note
  ideamine model <id> <haiku|sonnet|opus|fable>   override the recommended model
  ideamine next [--here]          the idea to build next
  ideamine go [id] [--print]      open Claude Code on the idea's recommended model, in its project
  ideamine go [id] --pipeline     the same, with the agent pipeline (/pipeline) as the request
  ideamine sort [--model sonnet] [--limit 20] [--dry-run]
                                  triage the inbox with one headless \`claude -p\` call
  ideamine watch [off]            the watcher: Haiku triages new ideas and pairs them with projects
  ideamine watch-pass             one pass of the watcher, now, in the foreground
  ideamine find <words...>        search by meaning (nomic-embed-text), in every lane
  ideamine groups [lane|-a]       ideas grouped by meaning
  ideamine embed                  embed new ideas, and show how the vectors and thresholds fit
  ideamine serve [--port 7411] [--open]
                                  the dashboard on this machine, with live data and actions
  ideamine publish [url|off] [--dir <folder>]
                                  upload the dashboard (index.html, data.json) now; a url also turns
                                  on the upload after each change; --dir writes the files to a folder
  ideamine config [key [value]]   show or change a setting (an empty value restores the default)
  ideamine export [file.md]       Markdown export of the whole archive
  ideamine path                   where the archive lives (override with IDEAMINE_HOME)
  ideamine mcp                    run the MCP server on stdio
  ideamine hook                   run the UserPromptSubmit hook (reads the hook JSON on stdin)`;

function parseArgs(argv) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['model', 'limit', 'budget', 'query', 'dir', 'port'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else words.push(a);
  }
  return { flags, words };
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function fail(message) {
  process.stderr.write(`ideamine: ${message}\n`);
  process.exit(1);
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);

  // The two machine entry points load only what they need.
  if (command === 'mcp') return (await import('../src/mcp.js')).serve({ prompts: !rest.includes('--plugin') });
  if (command === 'hook') return (await import('../src/hook.js')).runHook();

  const store = await import('../src/store.js');
  const render = await import('../src/render.js');
  const { splitIdeas, clip } = await import('../src/text.js');
  const { flags, words } = parseArgs(rest);
  const cwd = process.cwd();
  const needId = () => words[0] || fail(`usage: ideamine ${command} <id>`);

  switch (command) {
    case 'add': {
      const text = words.length === 1 && words[0] === '-' ? await readStdin() : words.join(' ');
      const results = store.addIdeas(splitIdeas(text), { source: 'cli', project: flags['no-project'] ? null : cwd });
      console.log(render.renderAdded(results, store.load()));
      break;
    }
    case 'ls': {
      const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
      const filter = lower.find((w) => store.FILTERS.includes(w)) || 'open';
      const here = lower.includes('here') || flags.here;
      console.log(render.renderBoard(store.load(), { filter, project: here ? cwd : null, query: flags.query || '', cwd }));
      break;
    }
    case 'cat': {
      needId();
      const db = store.load();
      const ideas = words.map((id) => store.findIdea(db, id) || fail(`no idea #${id.replace(/^#/, '')}`));
      console.log(ideas.map(render.renderIdea).join('\n\n'));
      break;
    }
    case 'rm': {
      needId();
      for (const idea of store.removeIdeas(words)) console.log(`Removed #${idea.id} ${clip(idea.title, 60)}`);
      break;
    }
    case 'done':
    case 'drop':
    case 'start':
    case 'doing':
    case 'reopen': {
      const status = { drop: 'dropped', start: 'doing' }[command] || command;
      const note = words.slice(1).join(' ');
      const idea = store.updateIdea(needId(), { status, note: note || undefined });
      console.log(`#${idea.id} ${clip(idea.title, 60)} → ${store.lane(idea)}`);
      break;
    }
    case 'note': {
      const note = words.slice(1).join(' ') || fail('usage: ideamine note <id> <text>');
      const idea = store.updateIdea(needId(), { note });
      console.log(`#${idea.id}: note added`);
      break;
    }
    case 'model': {
      const idea = store.updateIdea(needId(), { model: words[1] || fail('usage: ideamine model <id> <haiku|sonnet|opus|fable>') });
      console.log(`#${idea.id} will be built with ${idea.triage.model}`);
      break;
    }
    case 'next': {
      const idea = store.pickNext(store.load(), { project: cwd, only: !!flags.here });
      if (!idea) {
        console.log('Nothing is ready to build. Triage the inbox first: ideamine sort');
        break;
      }
      console.log(render.renderIdea(idea));
      break;
    }
    case 'go': {
      const { buildPrompt, launchSession, pipelinePrompt } = await import('../src/claude.js');
      const db = store.load();
      const idea = words[0] ? store.findIdea(db, words[0]) : store.pickNext(db, { project: cwd });
      if (!idea) fail(words[0] ? `no idea #${words[0]}` : 'nothing is ready to build; run: ideamine sort');
      const model = idea.triage?.model || 'sonnet';
      const dir = idea.project && fs.existsSync(idea.project) ? idea.project : cwd;
      const prompt = flags.pipeline ? pipelinePrompt(idea, { dir }) : buildPrompt(idea);
      if (flags.print) {
        console.log(`directory: ${dir}\nmodel:     ${model}\n\n${prompt}`);
        break;
      }
      store.updateIdea(idea.id, { status: 'doing', note: flags.pipeline ? 'pipeline: started' : undefined });
      console.log(`Opening Claude Code (${model}) in ${dir} for #${idea.id}${flags.pipeline ? ', through the agent pipeline' : ''}…`);
      process.exitCode = launchSession({ model, prompt, cwd: dir });
      break;
    }
    case 'sort': {
      const { headlessTriage } = await import('../src/claude.js');
      const out = await headlessTriage({
        model: typeof flags.model === 'string' ? flags.model : undefined,
        limit: Number(flags.limit) || 20,
        budget: Number(flags.budget) || 1,
        dryRun: !!flags['dry-run'],
      });
      if (out.message) {
        console.log(out.message);
        break;
      }
      const ok = out.results.filter((r) => !r.error);
      const spend = out.tokens ? ` (${out.tokens.input} in / ${out.tokens.output} out tokens, ~$${Number(out.cost || 0).toFixed(4)})` : '';
      console.log(`Triaged ${ok.length}${spend}:`);
      for (const r of ok) console.log(`  #${r.id} ${r.verdict.padEnd(5)} ${r.verdict === 'skip' ? '' : `${r.model.padEnd(6)} ${r.size.toUpperCase().padEnd(2)} `}${clip(r.title, 60)}`);
      for (const r of out.results.filter((x) => x.error)) console.log(`  #${r.id} not saved: ${r.error}`);
      break;
    }
    case 'watch': {
      const watch = await import('../src/watch.js');
      if (words[0] === 'off') watch.turnOff();
      else {
        watch.turnOn();
        watch.kick();
      }
      console.log(watch.status());
      break;
    }
    case 'watch-pass': {
      const watch = await import('../src/watch.js');
      if ((await watch.pass()) === 'error') process.exitCode = 1;
      break;
    }
    case 'find': {
      const embed = await import('../src/embed.js');
      const query = words.join(' ') || fail('usage: ideamine find <words...>');
      console.log(render.renderFound(await embed.find(store.load(), query), query, { cwd }));
      break;
    }
    case 'groups': {
      const embed = await import('../src/embed.js');
      const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
      const filter = lower.find((w) => store.FILTERS.includes(w)) || 'open';
      const ideas = store.listIdeas(store.load(), { filter });
      console.log(render.renderGroups(await embed.groupIdeas(ideas), ideas, { cwd, scope: filter }));
      break;
    }
    case 'embed': {
      const embed = await import('../src/embed.js');
      console.log(await embed.status(store.load()));
      break;
    }
    case 'serve': {
      const serve = await import('../src/serve.js');
      if (words[0] === 'off') {
        console.log(serve.stop());
        break;
      }
      const { url, close } = await serve.listen({ port: Number(flags.port) || serve.DEFAULT_PORT });
      console.log(`ideamine web: ${url}  (Ctrl-C stops it)`);
      if (flags.open) serve.openBrowser(url);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close().then(() => process.exit(0)));
      break;
    }
    case 'publish': {
      const publish = await import('../src/publish.js');
      if (flags.background) {
        process.exitCode = (await publish.backgroundPublish()) === 'error' ? 1 : 0;
        break;
      }
      const config = await import('../src/config.js');
      if (words[0] === 'off') {
        config.set('publish_url', '');
        console.log(publish.status());
        break;
      }
      if (words[0]) config.set('publish_url', words[0]);
      const out = await publish.publish({ dir: typeof flags.dir === 'string' ? flags.dir : null });
      console.log(`Published ${out.ideas} ideas and ${out.groups} groups to ${out.where}`);
      if (out.note) console.log(out.note);
      break;
    }
    case 'config': {
      const config = await import('../src/config.js');
      if (words.length >= 1 && rest.length >= 2) config.set(words[0], words.slice(1).join(' '));
      else if (words.length === 1 && rest.length === 1) {
        console.log(config.get(words[0]));
        break;
      }
      console.log(config.describe());
      break;
    }
    case 'export': {
      const md = render.renderMarkdown(store.load());
      if (words[0]) {
        fs.writeFileSync(words[0], md);
        console.log(`Wrote ${words[0]}`);
      } else process.stdout.write(md);
      break;
    }
    case 'path':
      console.log(store.dbPath());
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      fail(`unknown command "${command}". Try: ideamine help`);
  }
}

main().catch((e) => fail(e.message));
