# ideamine

**An idea inbox for Claude Code.** Save ideas as fast as you have them. Claude sorts them out later.

```
> /idea let the scroller pause when the mouse hovers over a link
  💡 Saved #43 · let the scroller pause when the mouse hovers over a link  (6 in inbox)
```

That line did not call the model. A hook answers `/idea` on your machine before any request goes to Claude, so saving an idea:

- **costs 0 tokens.** `claude -p "/idea …"` reports 0 turns, 0 input tokens, 0 output tokens, $0.
- **does not interrupt the current task.** Claude never sees the idea, so it cannot get distracted by it.
- **works on any model, in any session, and when you are out of usage.** Nothing is sent, so there is nothing to rate-limit.

Every session writes to one archive, `~/.ideamine/ideas.json`, whatever project or model it uses. The archive is a queue. Claude triages new ideas to put the queue in order: it decides which ideas are worth doing and picks the **cheapest model that can build each one**: Haiku for a typo, Sonnet for a feature, Opus for a redesign. Fable is only for the hardest problems. `/ideas-go` takes the idea that fits your chat, else the first one, and builds it.

## Install

In Claude Code (CLI, desktop, or IDE):

```bash
claude plugin marketplace add equwal/ideamine
```

```bash
claude plugin install ideamine@ideamine
```

Or from inside a session: `/plugin marketplace add equwal/ideamine`, then `/plugin install ideamine@ideamine`. Start a new session to load it. Requires Node.js 18 or later. There are no dependencies to install. Tested on Claude Code 2.1.224 (CLI) and 2.1.275 (desktop app) on Windows.

Marketplaces you add yourself do not auto-update. To upgrade, run `claude plugin marketplace update ideamine`, then `claude plugin update ideamine@ideamine`.

## Commands

| Command | What it does | Calls the model? |
|---|---|---|
| `/idea <text>` | Add an idea. A pasted bulleted list adds one idea per bullet. `#tags` are recorded. | **No** |
| `/ideas` | Show the queue: doing, do (best first), maybe, inbox | **No** |
| `/ideas-ls done` · `-a` · `here` | List one lane, every lane, or only this project | **No** |
| `/ideas-cat 12` | Show idea #12 in full: brief, model, notes | **No** |
| `/ideas-rm 12 14` | Delete ideas for good | **No** |
| `/ideas-done 12 shipped it` | Mark an idea done, with a note | **No** |
| `/ideas-reopen 12` | Put an idea back in the queue, for example one that the triage skipped | **No** |
| `/ideas-find sync subtitles` | Search every lane by meaning, not only by the words. See [Search by meaning](#search-by-meaning-and-groups). | **No** |
| `/ideas-groups` · `done` · `-a` | Show the ideas grouped by meaning | **No** |
| `/ideas-go [12]` | Build the idea that fits this chat, else the first in the queue, or #12, on its recommended model. New ideas are triaged first. | Yes, this is the build |
| `/ideas-pipeline [12]` | The same, through the agent pipeline of the [agent-pipeline](#with-the-agent-pipeline) plugin: research, storyboard, plan, engineers in parallel, test, validate. For big ideas. | Yes, this is the build |
| `/ideas-all` | Claude reads every idea, takes the ones that fit this chat out of the queue, and does them. The others stay in the queue. | Yes, this is the build |
| `/ideas-sort` | Triage the inbox now and show the queue. You do not have to: `/ideas-go` triages when it must. | Yes, briefly |
| `/ideas-watch [off]` | Turn on the watcher: Haiku triages each new idea and pairs it with its project, in the background. With no argument, it also shows what the watcher did. | Haiku, only for new ideas |
| `/ideas-web [off]` | Open the dashboard in your browser, served on this machine with live data. See [Dashboard](#dashboard). | **No** |
| `/ideas <question>` | Ask about your ideas, e.g. "which ones fit in an hour?" | Yes, briefly |

Each command has its own name, so the slash menu shows all of them when you type `/idea`. The plugin menu also shows them as `/ideamine:ideas-go` and so on. Both forms work.

`/ideas-go` does not ask questions. The queue puts the best `do` ideas first, then the best `maybe` ideas. Ideas that the triage marks `skip` stay out of the queue until you reopen or delete them.

You save ideas from any session, so the folder that ideamine records is only the folder you were in. That can be the scratch folder of another chat. For this reason, the triage pairs each idea with the project that it is about (see [The watcher](#the-watcher)), and `/ideas-go` and `/ideas-all` let Claude judge by the text which ideas fit the current chat, and where to build each one. `/ideas-go` builds in the current project when the idea fits it. Else it uses the recorded folder if that folder exists, or finds the project that the idea is about. If it cannot find the project, it stops and tells you.

Claude can also save ideas by itself. If you write "idea: dark mode for the popup" or "save that for later", it calls the `idea_add` tool and continues the current task.

## The watcher

```
> /ideas-watch
  ideamine watch: on since 2026-09-21 14:02. haiku triages new ideas and pairs each one with its project.
```

Run `/ideas-watch` once. After that, a few seconds after you save an idea, Haiku (the cheapest model) triages it and pairs it with its project. The triage chooses from the folders of your ideas and the projects that Claude Code knows (`~/.claude.json`), and it reads the first line of each README. If no project fits, for example for an idea for a new product, the idea stays where you saved it. The first pass also triages again the open ideas from before 0.4.0, so that they get a project too.

The watcher is not a process that stays alive, because a process like that can stop: a crash, a reboot, a full context, or a usage limit. Instead, the ideamine hook starts a short background pass when you send a prompt and there is work. Thus the watcher keeps going while you use Claude Code, and it costs nothing while no new ideas come in. A failed call gets 2 more tries in the same pass. After a failed pass, the watcher waits 10 minutes before it tries again. `/ideas-watch` shows the last passes, and `/ideas-watch off` turns the watcher off. In a terminal, `ideamine watch` does the same. The log is `~/.ideamine/watch.log`.

## Search by meaning and groups

```
> /ideas-find make money
  ideas like "make money", by meaning
    53% done    #4   sonnet S  ▲3  Research monetization models for device-hacking utility apps
```

`/ideas-find` finds ideas that mean the same thing as your words, also when they use other words. `/ideas-groups` puts ideas that are about the same thing in one group, for example all the ideas for one app. Both come from embeddings: an embedding model turns each idea into a vector, and ideas with similar meaning get similar vectors. The default model is [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5). The design follows [memstate](https://github.com/map588/memstate): the `search_document:` and `search_query:` task prefixes of nomic, one cached vector for each idea that ideamine computes again when the idea changes, cosine similarity with a threshold, and word search when the embedding server does not answer. The groups and the related ideas come from the same vectors, so ideamine needs no graph database.

ideamine sends the text of each new or changed idea to an embedding server that has an OpenAI-compatible `/v1/embeddings` endpoint. Two servers work:

- [Ollama](https://ollama.com) on your machine: `ollama pull nomic-embed-text`. This is the default (`http://127.0.0.1:11434/v1`).
- The [llama.cpp](https://github.com/ggml-org/llama.cpp) server on another machine, for example a small VPS. The model file is [`nomic-embed-text-v1.5.Q8_0.gguf`](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) (146 MB). With `-c 512` the server uses about 20 MB of memory plus the model file, which the kernel can page out:

  ```bash
  llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embeddings --pooling mean -c 512 -b 512 -ub 512 --alias nomic-embed-text --host 127.0.0.1 --port 8081
  ```

Then tell ideamine where the server is:

```bash
ideamine config embed_url http://10.66.0.1/v1
```

```bash
ideamine embed
```

`ideamine embed` embeds the ideas that have no vector yet. It also shows the similarity of each idea to its nearest neighbour, like `memstated embed status`. Use these numbers to set the thresholds for a new model. With nomic-embed-text, a search result must have a similarity of 0.5 or more (`search_threshold`), and the ideas in a group must have a mean similarity of 0.65 or more (`group_threshold`). A group gets a label from the words that its ideas share and other ideas do not use. If the server does not answer, `/ideas-find` searches by words and tells you why, and `/ideas-groups` tells you that it needs the server. The vectors are in `~/.ideamine/vectors.json`. When you delete an idea, its vector goes too.

Claude can search by meaning with `idea_list` and `semantic: true`, and group with `groups: true`.

## Dashboard

```
> /ideas-web
  ideamine web: http://127.0.0.1:7411/ (starting)
```

The dashboard is a web page of your ideas, with seven views:

| View | What it shows |
|---|---|
| Board | A column for each lane (doing, do, maybe, inbox, done), a ticket for each idea, in queue order |
| Timeline | A Gantt chart: how long each idea waited in the inbox, waited in the queue, and was in work |
| Table | Every idea in one sortable table: lane, model, size, impact, project, tags, age |
| Projects | A row for each project and a column for each lane, so you see where the work piles up |
| Flow | Tiles (open, done in 7 days, median lead and cycle time, model mix) and a cumulative flow chart of the lanes over time |
| Matrix | Impact against size. Quick wins in the top left, ideas to avoid in the bottom right |
| Groups | The ideas grouped by meaning |

The search box finds ideas by meaning in every view. A ticket opens a drawer with the brief, the notes, and the related ideas. The page is one static file, `index.html`, and it reads a snapshot, `data.json`. It loads nothing from the internet, and it shows skip and dropped ideas only when you tick "Show parked".

### On your machine

`/ideas-web` starts a small server on `127.0.0.1` and opens the page in your browser. The hook answers, so it costs no tokens. `/ideas-web off` stops the server. In a terminal, `ideamine serve [--port 7411] [--open]` runs the same server in the foreground.

Served this way, the page has live data and can change ideas, so it stands in for the local slash commands: the drawer of a ticket has buttons to start, finish, drop, reopen, or delete the idea, a box for a note, and a menu for the model. The page asks the server for new data every 5 seconds, and the server builds `data.json` again only when the archive changed. Only the page can change ideas: the server answers only on `localhost`, and it refuses a request that another web site sends from your browser (a foreign `Host`, a form body, or a cross-site fetch). `~/.ideamine/serve.json` records the running server.

### On a server of your own

`ideamine publish` uploads the same page and a snapshot to a web server. The published page is read-only.

```bash
ideamine publish http://10.66.0.1/
```

This uploads both files with HTTP PUT. It also saves the address, so the ideamine hook publishes again in the background after each change, at no model cost. `ideamine publish off` stops that. `ideamine publish --dir <folder>` writes the two files to a folder instead. The timeline uses the time when an idea went to `doing`. ideamine records that time from 0.5.0 on, so for older ideas the timeline shows an estimated bar.

The snapshot contains the full text of your ideas. Serve it only where only you can open it. For example, this nginx site answers only on the address of a WireGuard interface, and it accepts uploads only from one peer:

```nginx
server {
    listen 10.66.0.1:80;           # the WireGuard address of the server
    allow 10.66.0.0/24;            # WireGuard peers only
    deny all;
    root /var/www/ideamine;
    location ~ ^/(index\.html|data\.json)$ {
        limit_except GET HEAD { allow 10.66.0.2; deny all; }   # only your PC uploads
        dav_methods PUT;
        client_max_body_size 16m;
    }
    location /v1/ { proxy_pass http://127.0.0.1:8081; }        # the llama.cpp server, for search on the page
}
```

`data.json` has `version` (1), `generated`, `embed` (model, query prefix, thresholds, and whether vectors are present), `counts`, `ideas`, `groups`, `flow` (the times and the count of each lane at each time, for the cumulative flow chart), and `stats` (the tiles of the Flow view). When `ideamine serve` serves it, it also has `api: true`, which turns on the actions, and `note`, which says when search by meaning is not available. Each idea has its ticket key (`IDEA-12`), lane, rank in the queue, triage, times (`created`, `triaged`, `started`, `closed`), timeline `phases`, notes, `group`, `related` ideas with their similarity, and `vec`, the vector as base64 of little-endian float32.

## With the agent pipeline

```
> /ideas-pipeline 12
  #12 sync subtitles with the audiobook → /work/app, through the agent pipeline
```

`/ideas-go` gives an idea to one subagent. For a big idea, `/ideas-pipeline` gives it to the [agent-pipeline](https://github.com/map588/agents) plugin instead: a researcher maps the project, a story-writer turns the idea into stories, a project manager plans tasks, engineers build them in parallel worktrees, an integrator merges, and a tester and a validator check the result. The pipeline asks you to approve the stories and the plan. `/ideas-go` points to `/ideas-pipeline` when an idea is size L or XL.

The idea is the record of the run. The request tells the pipeline to add a note to the idea after each phase (`pipeline: research done`, `pipeline: plan approved`, `pipeline: wave 1 integrated`, ...), marks the idea done when its tests and validation pass, and leaves it in `doing` with a note when it stops at its iteration cap. The dashboard shows the latest note on the ticket in the Doing column, and the drawer shows them all. In a terminal, `ideamine go 12 --pipeline` opens Claude Code with the same request.

## Model routing

The triage gives each idea a verdict (`do`, `maybe`, `skip`), an impact from 1 to 5, a size from `xs` to `xl`, a one-line reason, and a short brief that an agent can act on without the original chat. It also picks the cheapest model that is likely to finish the idea in one pass. If a weaker model fails and has to retry, that costs more than using the right model once.

| Model | $ in / out per 1M tokens | Gets ideas like |
|---|---|---|
| `haiku` (Haiku 4.5) | $1 / $5 | mechanical, fully specified, local work: typos, renames, config tweaks, boilerplate, small scripts |
| `sonnet` (Sonnet 5) | $2 / $10 | the default: ordinary features, bug fixes with a clear repro, tests, docs, contained refactors |
| `opus` (Opus 5) | $5 / $25 | ambiguous or cross-cutting work: architecture, hard debugging, performance, security |
| `fable` (Fable 5.1) | $10 / $50 | only the hardest long-horizon or research-grade problems |

The triage does not run on your session's model. `/ideas-go` and `/ideas-sort` make one tool call, and the MCP server hands the work to a separate, minimal `claude -p` run on Sonnet (see below). Only new ideas are triaged, once each. A session on Opus or Fable therefore pays the same few cents as a session on Haiku. If that CLI is not available, Claude does the triage itself.

Recommendations are stored as aliases, so they stay valid when a newer model ships under the same name. `/ideas-go` gives the build to a subagent on the recommended model. The subagent starts with a clean context, so the build does not also re-read your whole conversation. To override a recommendation, run `ideamine model 12 opus` or ask Claude.

## Headless triage

```bash
ideamine sort
```

`/ideas-go` and `/ideas-sort` use this same engine. It is one `claude -p` call on your normal Claude Code login, with no tools, no MCP servers, no settings, a two-line system prompt, and a JSON schema for the output. Four ideas take about 1,700 input tokens, roughly two cents on Sonnet. A normal model turn in a setup with a few MCP servers can re-read tens of thousands of tokens. To keep the inbox sorted while you sleep, schedule the command with cron or Task Scheduler. `--model haiku` makes it cheaper, and `--dry-run` shows the exact prompt.

## Command line

```bash
npm install -g github:equwal/ideamine
```

```
ideamine add "support vim keys in the popup"      # "-" reads stdin
ideamine ls [inbox|do|maybe|skip|doing|done|-a] [here]
ideamine cat 12
ideamine rm 12                                    # delete for good
ideamine done 12 "shipped in v1.4"                # also: drop, start, reopen, note
ideamine next                                     # what to build next
ideamine go 12                                    # opens Claude Code on the right model, in the idea's project
ideamine go 12 --pipeline                         # the same, with the agent pipeline as the request
ideamine sort                                     # headless triage (see above)
ideamine watch [off]                              # the watcher (see above)
ideamine find sync subtitles                      # search by meaning
ideamine groups [-a]                              # ideas grouped by meaning
ideamine embed                                    # embed new ideas, show the similarity numbers
ideamine serve [--port 7411] [--open]             # the dashboard on this machine, with live data and actions
ideamine publish [url|off] [--dir folder]         # the dashboard on a server of your own
ideamine config [key [value]]                     # show or change a setting
ideamine export IDEAS.md                          # Markdown copy of everything
```

## Other MCP clients

The MCP server works without the plugin. For Claude Desktop, Cursor, or any stdio MCP client:

```json
{
  "mcpServers": {
    "ideamine": { "command": "npx", "args": ["-y", "github:equwal/ideamine", "mcp"] }
  }
}
```

Tools: `idea_add`, `idea_list`, `idea_triage`, `idea_update`, `idea_next`, `idea_remove`. Outside the plugin, the slash commands are MCP prompts. Without the hook, saving goes through the model, which costs a few tokens.

## Where your ideas live

`~/.ideamine/ideas.json` is plain, readable JSON. Set `IDEAMINE_HOME` to move it, for example into a synced folder. Each write takes a lock and then replaces the file in one step, so many sessions can write at the same time without losing an idea. The previous version is kept as `ideas.json.bak`. If the file becomes damaged, ideamine stops and does not overwrite it. Nothing leaves your machine, except in these cases: triage and builds go through Claude as usual; search by meaning and groups send the text of your ideas to the embedding server that you set; `ideamine publish` uploads a snapshot to the dashboard server that you set. So that it can pair ideas with projects, the triage also sends the paths of your project folders and the first line of each README.

`ideamine config` shows each setting and where its value comes from. `ideamine config <key> <value>` saves a setting in `~/.ideamine/config.json`, and an empty value restores the default. An environment variable wins over the file.

| Variable | Setting | Default | Purpose |
|---|---|---|---|
| `IDEAMINE_HOME` | | `~/.ideamine` | archive location |
| `IDEAMINE_TRIAGE_MODEL` | | `sonnet` | model for the headless triage |
| `IDEAMINE_CLAUDE_BIN` | | `claude` | Claude Code executable |
| `IDEAMINE_SETTING_SOURCES` | | *(empty)* | set to `user` if your login needs `settings.json` (e.g. `apiKeyHelper`) |
| `IDEAMINE_EMBED_URL` | `embed_url` | `http://127.0.0.1:11434/v1` | OpenAI-compatible embeddings API (Ollama, llama.cpp server) |
| `IDEAMINE_EMBED_MODEL` | `embed_model` | `nomic-embed-text` | embedding model; nomic models get their task prefixes |
| `IDEAMINE_SEARCH_THRESHOLD` | `search_threshold` | `0.5` | lowest similarity of a search result |
| `IDEAMINE_GROUP_THRESHOLD` | `group_threshold` | `0.65` | lowest mean similarity in a group, and of a related idea |
| `IDEAMINE_PUBLISH_URL` | `publish_url` | *(off)* | dashboard server for `ideamine publish` |

## How it works

```
/idea …          ──► UserPromptSubmit hook ──► ~/.ideamine/ideas.json ──► "💡 Saved #43"   (model never called)
/ideas, /ideas-ls, -cat, -rm, -done ──► same hook, answers locally

/ideas-go        ──► Claude ──► MCP idea_next ──► claude -p (Sonnet, minimal context), for new ideas only
                                              ──► verdict · impact · size · cheapest capable model · brief
                            ──► subagent on that model ──► builds it ──► idea_update: done
/ideas-all       ──► Claude ──► MCP idea_list (full) ──► idea_remove for the ideas that fit this chat ──► builds them

watcher on: any prompt ──► hook ──► background pass ──► claude -p (Haiku) ──► verdicts + a project for each idea

/ideas-find, /ideas-groups ──► hook ──► embedding server (new ideas only) ──► cosine similarity ──► answer
/ideas-web       ──► hook ──► ideamine serve on 127.0.0.1 ──► browser: live data.json every 5 s, actions via api/ideas
publish on: any prompt after a change ──► hook ──► background publish ──► PUT index.html + data.json
```

The plugin contains a Node MCP server with no dependencies, fifteen skills (the slash commands), and one hook. The hook answers `/idea`, `/ideas`, and the local `/ideas-*` commands before any API call, and it lets every other prompt through. The hook runs directly, not through a shell, and takes about 130 ms per prompt on Windows. The skills are user-only, so their descriptions add no tokens to your sessions. If the archive cannot be read, the hook lets the prompt through, so the `/idea` skill can still save it with the MCP tool. Your text is never dropped.

## Development

```bash
npm install
```

```bash
npm test
```

The tests use `node:test`, and [fast-check](https://fast-check.dev) for the property tests. fast-check is a development dependency only: the plugin itself installs nothing. The tests cover the store, including concurrent writers from several processes, the hook, the MCP protocol, headless triage with pairing, the watcher, embeddings and groups, the dashboard upload, the local dashboard server, and the flow series. Triage runs against a stand-in `claude`, and embeddings and uploads run against a stand-in server, so the tests spend no tokens and need no network.

## License

MIT
