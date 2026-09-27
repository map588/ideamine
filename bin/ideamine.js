#!/usr/bin/env node
// ideamine CLI. Also the entry point the plugin uses for its MCP server (`mcp`) and hook (`hook`).

import { spawnSync } from 'node:child_process';
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
  ideamine publish [url|off] [--dir <folder>]
                                  upload the dashboard (index.html, data.json) now; a url also turns
                                  on the upload after each change; --dir writes the files to a folder
  ideamine serve [--port 4332]    the dashboard with a button for each command, at 127.0.0.1
  ideamine sync [url|off]         share the archive of every machine through an ideamine server
  ideamine prompts import         put the prompts of older Claude Code chats into the prompt log
  ideamine usage [days]           tokens, models, and price for each project (0 days: all time)
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
  // A window that the dashboard opened closes when the command ends. Wait for a key, so that the
  // user can read the error.
  if (process.env.IDEAMINE_WINDOW && process.stdin.isTTY) {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'pause'], { stdio: 'inherit' });
  }
  process.exit(1);
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);

  // The two machine entry points load only what they need.
  if (command === 'mcp') return (await import('../src/mcp.js')).serve({ prompts: !rest.includes('--plugin') });
  if (command === 'hook') return (await import('../src/hook.js')).runHook();

  const store = await import('../src/store.js');
  const archive = await import('../src/archive.js');
  const render = await import('../src/render.js');
  const { splitIdeas, clip } = await import('../src/text.js');
  const { flags, words } = parseArgs(rest);
  const cwd = process.cwd();
  const needId = () => words[0] || fail(`usage: ideamine ${command} <id>`);
  // A change that waits for the ideamine server: say so, and go on.
  const queued = (out) => out.queued && (console.log(archive.queuedText(out)), true);

  switch (command) {
    case 'add': {
      const text = words.length === 1 && words[0] === '-' ? await readStdin() : words.join(' ');
      const results = await archive.add(splitIdeas(text), { source: 'cli', project: flags['no-project'] ? null : cwd });
      if (!queued(results)) console.log(render.renderAdded(results, store.load()));
      break;
    }
    case 'ls': {
      const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
      const filter = lower.find((w) => store.FILTERS.includes(w)) || 'open';
      const here = lower.includes('here') || flags.here;
      console.log(render.renderBoard(await archive.fresh(), { filter, project: here ? cwd : null, query: flags.query || '', cwd }));
      break;
    }
    case 'cat': {
      needId();
      const db = await archive.fresh();
      const ideas = words.map((id) => store.findIdea(db, id) || fail(`no idea #${id.replace(/^#/, '')}`));
      console.log(ideas.map(render.renderIdea).join('\n\n'));
      break;
    }
    case 'rm': {
      needId();
      const gone = await archive.remove(words);
      if (!queued(gone)) for (const idea of gone) console.log(`Removed #${idea.id} ${clip(idea.title, 60)}`);
      break;
    }
    case 'done':
    case 'drop':
    case 'start':
    case 'doing':
    case 'reopen': {
      const status = { drop: 'dropped', start: 'doing' }[command] || command;
      const note = words.slice(1).join(' ');
      const idea = await archive.update(needId(), { status, note: note || undefined });
      if (!queued(idea)) console.log(`#${idea.id} ${clip(idea.title, 60)} → ${store.lane(idea)}`);
      break;
    }
    case 'note': {
      const note = words.slice(1).join(' ') || fail('usage: ideamine note <id> <text>');
      const idea = await archive.update(needId(), { note });
      if (!queued(idea)) console.log(`#${idea.id}: note added`);
      break;
    }
    case 'model': {
      const idea = await archive.update(needId(), { model: words[1] || fail('usage: ideamine model <id> <haiku|sonnet|opus|fable>') });
      if (!queued(idea)) console.log(`#${idea.id} will be built with ${idea.triage.model}`);
      break;
    }
    case 'next': {
      const idea = store.pickNext(await archive.fresh(), { project: cwd, only: !!flags.here });
      if (!idea) {
        console.log('Nothing is ready to build. Triage the inbox first: ideamine sort');
        break;
      }
      console.log(render.renderIdea(idea));
      break;
    }
    case 'go': {
      const { goPlan, launchSession, pipelinePrompt } = await import('../src/claude.js');
      const db = await archive.fresh();
      const idea = words[0] ? store.findIdea(db, words[0]) : store.pickNext(db, { project: cwd });
      if (!idea) fail(words[0] ? `no idea #${words[0]}` : 'nothing is ready to build; run: ideamine sort');
      const plan = goPlan(idea, cwd);
      const { model, dir } = plan;
      const prompt = flags.pipeline ? pipelinePrompt(idea, { dir }) : plan.prompt;
      if (flags.print) {
        console.log(`directory: ${dir}\nmodel:     ${model}\n\n${prompt}`);
        break;
      }
      queued(await archive.update(idea.id, { status: 'doing', note: flags.pipeline ? 'pipeline: started' : undefined }));
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
      console.log(render.renderFound(await embed.find(await archive.fresh(), query), query, { cwd }));
      break;
    }
    case 'groups': {
      const embed = await import('../src/embed.js');
      const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
      const filter = lower.find((w) => store.FILTERS.includes(w)) || 'open';
      const ideas = store.listIdeas(await archive.fresh(), { filter });
      console.log(render.renderGroups(await embed.groupIdeas(ideas), ideas, { cwd, scope: filter }));
      break;
    }
    case 'embed': {
      const embed = await import('../src/embed.js');
      console.log(await embed.status(store.load()));
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
    case 'serve': {
      const serve = await import('../src/serve.js');
      const { server, url } = await serve.start({
        ...(flags.port ? { port: Number(flags.port) } : {}),
        log: (text) => console.log(serve.logLine(text)),
      });
      server.on('close', () => process.exit(0)); // /ideas-web off
      console.log(serve.logLine(`the dashboard with buttons runs at ${url} (Ctrl+C stops it)`));
      break;
    }
    case 'sync': {
      const sync = await import('../src/sync.js');
      if (flags.background) {
        process.exitCode = (await sync.backgroundSync()) === 'error' ? 1 : 0;
        break;
      }
      if (words[0]) {
        const backup = sync.setServer(words[0] === 'off' ? '' : words[0]);
        if (backup) console.log(`The archive that was here is in ${backup}.`);
      }
      if (sync.enabled()) {
        try {
          await sync.pull({ timeoutMs: 30000, prompts: true });
        } catch (e) {
          if (!(e instanceof sync.SyncError)) throw e;
          process.exitCode = 1;
        }
      }
      console.log(sync.status());
      break;
    }
    case 'prompts': {
      const sync = await import('../src/sync.js');
      if (words[0] !== 'import') fail('usage: ideamine prompts import');
      if (!sync.enabled()) fail('the prompt log goes to an ideamine server. Turn sync on first: ideamine sync <url>');
      console.log(`Put ${sync.importPrompts()} prompts from ${sync.transcriptsDir()} into the prompt outbox. The next sync sends them.`);
      break;
    }
    case 'usage': {
      const usage = await import('../src/usage.js');
      const days = Number(words[0]) || 0;
      const { rows, files } = usage.scan();
      const projects = usage.byProject(usage.since(rows, days));
      const money = (n) => `$${n.toFixed(2)}`;
      const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
      const total = projects.reduce((n, p) => n + p.cost, 0);
      console.log(`ideamine usage: ${money(total)} in ${days ? `the last ${days} days` : 'all time'}, from ${files} transcripts. The price is the price of the API.`);
      for (const p of projects.slice(0, Number(process.env.IDEAMINE_USAGE_LIMIT) || 20)) {
        console.log(`\n  ${money(p.cost).padStart(9)}  ${p.project}`);
        console.log(`             in ${tokens(p.input)} · out ${tokens(p.output)} · cache write ${tokens(p.write5m + p.write1h)} · cache read ${tokens(p.read)} · ${p.messages} answers`);
        for (const m of Object.values(p.models).sort((a, b) => b.cost - a.cost)) {
          console.log(`             ${money(m.cost).padStart(9)}  ${m.model}${usage.priced(m.model) ? '' : ' (no price for this model)'}`);
        }
      }
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
      const md = render.renderMarkdown(await archive.fresh());
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
