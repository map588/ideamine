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
| `/ideas-web` · `off` | Start the dashboard with a button for each command on this PC, and show its address. See [Buttons](#buttons). | **No** |
| `/ideas-sync <url>` · `off` | Share one archive between all your machines through an ideamine server. See [One archive for every machine](#one-archive-for-every-machine). | **No** |
| `/ideas-go [12]` | Build the idea that fits this chat, else the first in the queue, or #12, on its recommended model. New ideas are triaged first. | Yes, this is the build |
| `/ideas-pipeline [12]` | The same, through the [agent pipeline](#with-the-agent-pipeline) that ships with ideamine: research, storyboard, plan, engineers in parallel, test, validate. For big ideas. | Yes, this is the build |
| `/ideas-all` | Claude reads every idea, takes the ones that fit this chat out of the queue, and does them. The others stay in the queue. | Yes, this is the build |
| `/ideas-sort` | Triage the inbox now and show the queue. You do not have to: `/ideas-go` triages when it must. | Yes, briefly |
| `/ideas-watch [off]` | Turn on the watcher: Haiku triages each new idea and pairs it with its project, in the background. With no argument, it also shows what the watcher did. | Haiku, only for new ideas |
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

With [sync](#one-archive-for-every-machine) on, the ideamine server holds the vectors. It embeds each idea once for every machine, with its own embedding server and model, and a machine that syncs reads the vectors from `/api/vectors` and keeps no `vectors.json`. The search query goes through the server too, so the query and the ideas get their vectors from one model. `embed_url` and `embed_model` then matter only on the server. When the copy of an idea on a machine is newer than the one on the server, for example while a change waits in the outbox, the server embeds that text too, and nothing is kept on the machine.

## Dashboard

`ideamine publish` makes a web page of your ideas. A ticket opens a preview with the brief, the notes, and the related ideas, and the search box finds ideas by meaning in every view. The page is one static file, `index.html`, and it reads a snapshot, `data.json`. It loads nothing from the internet. Skip and dropped ideas show only when you tick "Show parked".

| View | What it shows |
|---|---|
| Board | A column for each lane (doing, do, maybe, inbox, done), a ticket for each idea, in queue order. A ticket in Doing shows its latest note. |
| Timeline | A Gantt chart: how long each idea waited in the inbox, waited in the queue, and was in work |
| Table | Every idea in one sortable table: lane, model, size, impact, project, tags, age |
| Projects | A row for each project and a column for each lane, so you see where the work piles up |
| Flow | Tiles (open, done in 7 days, median lead and cycle time, model mix) and a cumulative flow chart of the lanes over time |
| Matrix | Impact against size. Quick wins in the top left, ideas to avoid in the bottom right |
| Groups | The ideas grouped by meaning |

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

`data.json` has `version` (1), `generated`, `embed` (model, query prefix, thresholds, and whether vectors are present), `counts`, `ideas`, `groups`, `flow` (the times and the count of each lane at each time, for the cumulative flow chart), and `stats` (the tiles of the Flow view). Each idea has its ticket key (`IDEA-12`), lane, rank in the queue, triage, times (`created`, `triaged`, `started`, `closed`), timeline `phases`, notes, `group`, `related` ideas with their similarity, and `vec`, the vector as base64 of little-endian float32. The `data.json` of `ideamine serve` also has `live` (see below).

### Buttons

```
> /ideas-web
  ideamine web: http://127.0.0.1:4332/ (started)
```

`/ideas-web` starts `ideamine serve` in the background and shows its address. That page is the same dashboard, with a button for each command:

| Button | Command |
|---|---|
| **+ Idea** | `/idea`. A bulleted list adds one idea for each bullet. |
| **Triage inbox** | `/ideas-sort` |
| **Build next**, and **Build with Claude** on a ticket | `/ideas-go`, `/ideas-go N`. New ideas are triaged first. Then a new terminal window opens Claude Code on the recommended model, in the project of the idea. Windows only. |
| **Ask** | `/ideas <question>`. Claude answers from the whole archive, and each `#12` in the answer opens that ticket. |
| **Watcher** | `/ideas-watch`, `/ideas-watch off` |
| **Start**, **Done**, **Drop**, **Reopen**, **Delete** on a ticket | `ideamine start`, `/ideas-done`, `ideamine drop`, `/ideas-reopen`, `/ideas-rm` |
| **Add note**, **Build model** on a ticket | `ideamine note`, `ideamine model` |

The board, the timeline, the groups, and the search show `/ideas`, `/ideas-ls`, `/ideas-cat`, `/ideas-groups`, and `/ideas-find`. `/ideas-all` has no button, because it needs the chat that it works in.

### Drag a card

On the board, drag a card into another lane. The lane says what happens:

| Lane | What the drag does |
|---|---|
| **Doing** | Where Claude Code runs, a new window opens Claude Code on the idea, like **Build with Claude**. On a page without Claude Code, the card only moves to Doing. |
| **Do**, **Maybe**, **Skip** | Only the verdict of the triage changes. The impact, the size, the model, and the text of the triage stay. |
| **Inbox** | The idea waits for a new triage. |
| **Done**, **Dropped** | The same as the **Done** and **Drop** buttons, but without a note. |

A drag needs a mouse or a trackpad. On a touch screen, use the buttons on the ticket.

Triage, Build, Ask, and the watcher need the Claude Code login, so they show only where Claude Code runs. The commands run on your PC, because your Claude Code login is there. Thus the server listens on `127.0.0.1` only, and it takes commands only from its own page: each command must be JSON from the same origin, and the Host header must name the server. Another web page in your browser cannot send commands to it, and no other page can show it in a frame. After a change, the server uploads the dashboard again when `publish_url` is set, so the copy on your dashboard server stays current. That copy has no buttons: it shows "Read-only copy". `/ideas-web off` stops the server. In a terminal, `ideamine serve` runs it in the foreground. To use another port, run `ideamine config serve_port 5000`. The log is `~/.ideamine/serve.log`.

## One archive for every machine

```
> /ideas-sync http://10.66.0.1/
  ideamine sync: http://10.66.0.1/
  last sync 2026-09-21 19:24, revision 212.
```

Without sync, each machine has its own archive. With sync, an ideamine server holds one archive, and every Claude on every machine reads and changes it. The server is `ideamine serve` on a machine that all your machines can reach, for example a small VPS on a WireGuard network. Its page is the same dashboard for every machine.

Each machine keeps a copy of the archive, so that `/ideas` and the other reads stay fast. A change goes into an outbox on the machine first, and then to the server. If the server does not answer, for example because the tunnel is down, the change waits in the outbox and goes with the next sync. Thus no idea is lost. `/idea` then says "Saved here", and `/ideas` says that it shows the copy on this machine. The server applies each change only once, also when a machine sends it twice. A background sync after your prompts sends what waits, and it gets the changes of the other machines at most once a minute. Prompts for the prompt log go at most every 20 seconds, so that a prompt does not start a process each time. The first `/ideas-sync` saves the archive that was on the machine as `ideas.before-sync-<date>.json`, because the archive of the server takes its place.

On the server, sync stays off. It serves the archive, and nginx gives it the address of the WireGuard interface:

```bash
IDEAMINE_HOME=/var/lib/ideamine IDEAMINE_SERVE_HOSTS=10.66.0.1 ideamine serve --port 4332
```

```nginx
server {
    listen 10.66.0.1:80;
    allow 10.66.0.0/24;
    deny all;
    location / { proxy_pass http://127.0.0.1:4332; proxy_set_header Host $host; client_max_body_size 2m; }
    location /v1/ { proxy_pass http://127.0.0.1:8081; }   # the embedding server
}
```

`serve_hosts` names the Host that nginx sends. Without it, the server refuses the request, so a DNS rebinding page cannot reach the archive. The server does not ask who you are: the network decides who can reach it. Put it only on a private network like WireGuard.

The server also makes the vectors for [search by meaning and groups](#search-by-meaning-and-groups), for every machine: set `embed_url` on the server. The machines read the vectors from `/api/vectors`.

### HTTPS for a name that is only on the tunnel

`mem.equwal.com` points to a WireGuard address, so Let's Encrypt cannot reach it over HTTP. The certificate therefore comes from a DNS challenge that the server answers itself. `deploy/acme-zone.sh` installs `nsd` with one small zone, `acme.equwal.com`, and a certbot hook that writes the token into that zone. `nsd` answers only this zone, so it is no open resolver. `deploy/tls.sh` gets the certificate and adds the HTTPS server block to nginx.

The owner of the domain adds three records one time:

| Type | Host | Value |
|---|---|---|
| A | `ns1` | the public address of the server |
| NS | `acme` | `ns1.equwal.com` |
| CNAME | `_acme-challenge.mem` | `mem.acme.equwal.com.` |

The nameserver name has three labels, because Namecheap refuses a nameserver value with two labels. certbot keeps the hooks in the renewal file, so each renewal writes a new token without help. Plain HTTP stays on, because the address of the tunnel and older bookmarks use it.

### On your phone

The dashboard is also an app for a phone. Open it and put it on the home screen: it gets the ideamine icon and opens without the address bar.

- **iPhone or iPad**: open `https://mem.equwal.com` in Safari, then "Share" and "Add to Home Screen". Plain HTTP also works.
- **Android**: Chrome offers "Install app" on `https://mem.equwal.com`. The installed app also takes a share: send a text from another app to ideamine, and the page opens with that text in the composer.
- `?text=...` and `?new=1` open the composer too, so a shortcut or another app can save an idea in one step.
- The service worker keeps the page and its icons, so the app opens when the tunnel to the server is down. The ideas, the prompts, and the memories always come from the server: an old copy of them would say the wrong thing.

The icons are in the repository. `node dashboard/icons.mjs` draws them again.

`android/` holds an Android app: the same page in a window of its own, with a share button. Send a text from any app to ideamine, and the composer opens with it. See [android/README.md](android/README.md). It is not in a store, because the dashboard answers only on your private network, where a reviewer cannot reach it.

### Prompts, Memory, and Usage

The dashboard can also show what your Claudes did:

- **Prompts**: each prompt that you typed, on every machine, as a timeline of sessions. `ideamine config prompt_log on` sends each prompt to the ideamine server in the background. The full text goes, without the notes that Claude Code puts into a prompt; a paste longer than 100,000 characters is cut. `ideamine prompts import` sends the prompts of your older chats from the Claude Code transcripts.
- **Memory**: the memories of a [memstate](https://github.com/map588/memstate) daemon: a timeline of the writes of each project, the latest writes, and each memory with its versions. Set `memstate_url` on the server, for example `http://127.0.0.1:8765`. The dashboard only reads memstate.
- **Usage**: the tokens, the models, and the price for each project. Claude Code writes a transcript for each session, and each answer in it carries the model and the token counts. ideamine adds them up for each day, project, and model, and puts the API price on them. Each machine sends its numbers with the sync, at most every 10 minutes, and the dashboard shows every machine together. `ideamine usage [days]` prints the same table in a terminal.

  The price is the price of the API (see [pricing](https://www.anthropic.com/pricing)): a cache write costs 1.25 times the input price with the 5-minute lifetime and 2 times with the 1-hour lifetime, and a cache read is much cheaper than input. **A Claude subscription does not bill for each token**, so with a subscription the price says what the same work would cost through the API. A model that the price list does not know shows 0. The price list is `PRICES` in `src/usage.js`.

## With the agent pipeline

```
> /ideas-pipeline 12
  #12 sync subtitles with the audiobook → /work/app, through the agent pipeline
```

`/ideas-go` gives an idea to one subagent. For a big idea, `/ideas-pipeline` gives it to the agent pipeline instead: a researcher maps the project, a story-writer turns the idea into stories, a project manager plans tasks, engineers build them in parallel worktrees, an integrator merges, and a tester and a validator check the result. The pipeline asks you to approve the stories and the plan. `/ideas-go` points to `/ideas-pipeline` when an idea is size L or XL.

The pipeline ships with ideamine: the seven agents are in `agents/`, and `/pipeline <request>` runs it for any request, not only for an idea. They are a copy of [map588/agents](https://github.com/map588/agents), which describes each role.

The idea is the record of the run. The request tells the pipeline to add a note to the idea after each phase (`pipeline: research done`, `pipeline: plan approved`, `pipeline: wave 1 integrated`, ...), to mark the idea done when its tests and validation pass, and to leave it in `doing` with a note when it stops at its iteration cap. The dashboard shows the latest note on the ticket in the Doing column, and the drawer shows them all. In a terminal, `ideamine go 12 --pipeline` opens Claude Code with the same request.

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
ideamine publish [url|off] [--dir folder]         # the dashboard (see above)
ideamine serve [--port 4332]                      # the dashboard with buttons, on 127.0.0.1
ideamine sync [url|off]                           # one archive for every machine (see above)
ideamine prompts import                           # the prompts of older chats, for the Prompts tab
ideamine usage [days]                             # tokens, models, and price for each project
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

`~/.ideamine/ideas.json` is plain, readable JSON. Set `IDEAMINE_HOME` to move it, for example into a synced folder. Each write takes a lock and then replaces the file in one step, so many sessions can write at the same time without losing an idea. The previous version is kept as `ideas.json.bak`. If the file becomes damaged, ideamine stops and does not overwrite it. Nothing leaves your machine, except in these cases: triage and builds go through Claude as usual; search by meaning and groups send the text of your ideas to the embedding server that you set, or with sync on to the one of the ideamine server; `ideamine publish` uploads a snapshot to the dashboard server that you set; with sync on, the archive is on the ideamine server, and with the prompt log on, your prompts go there too. So that it can pair ideas with projects, the triage also sends the paths of your project folders and the first line of each README.

`ideamine config` shows each setting and where its value comes from. `ideamine config <key> <value>` saves a setting in `~/.ideamine/config.json`, and an empty value restores the default. An environment variable wins over the file.

| Variable | Setting | Default | Purpose |
|---|---|---|---|
| `IDEAMINE_HOME` | | `~/.ideamine` | archive location |
| `IDEAMINE_TRIAGE_MODEL` | | `sonnet` | model for the headless triage |
| `IDEAMINE_CLAUDE_BIN` | | `claude` | Claude Code executable |
| `IDEAMINE_SETTING_SOURCES` | | *(empty)* | set to `user` if your login needs `settings.json` (e.g. `apiKeyHelper`) |
| `IDEAMINE_EMBED_URL` | `embed_url` | `http://127.0.0.1:11434/v1` | OpenAI-compatible embeddings API (Ollama, llama.cpp server); with sync on, the one of the server applies |
| `IDEAMINE_EMBED_MODEL` | `embed_model` | `nomic-embed-text` | embedding model; nomic models get their task prefixes; with sync on, the one of the server applies |
| `IDEAMINE_SEARCH_THRESHOLD` | `search_threshold` | `0.5` | lowest similarity of a search result |
| `IDEAMINE_GROUP_THRESHOLD` | `group_threshold` | `0.65` | lowest mean similarity in a group, and of a related idea |
| `IDEAMINE_PUBLISH_URL` | `publish_url` | *(off)* | dashboard server for `ideamine publish` |
| `IDEAMINE_SERVE_PORT` | `serve_port` | `4332` | port of `ideamine serve` and `/ideas-web` |
| `IDEAMINE_SERVE_HOSTS` | `serve_hosts` | *(none)* | more Host names that `ideamine serve` answers, for a server behind nginx |
| `IDEAMINE_SYNC_URL` | `sync_url` | *(off)* | the ideamine server that holds the archive of every machine |
| `IDEAMINE_PROMPT_LOG` | `prompt_log` | `off` | `on` sends each prompt to the ideamine server |
| `IDEAMINE_MEMSTATE_URL` | `memstate_url` | *(off)* | the memstated daemon for the Memory tab |

## How it works

```
/idea …          ──► UserPromptSubmit hook ──► ~/.ideamine/ideas.json ──► "💡 Saved #43"   (model never called)
/ideas, /ideas-ls, -cat, -rm, -done ──► same hook, answers locally

/ideas-go        ──► Claude ──► MCP idea_next ──► claude -p (Sonnet, minimal context), for new ideas only
                                              ──► verdict · impact · size · cheapest capable model · brief
                            ──► subagent on that model ──► builds it ──► idea_update: done
/ideas-pipeline  ──► Claude ──► MCP idea_next ──► the pipeline skill ──► seven agents, two gates ──► idea_update: a note after each phase
/ideas-all       ──► Claude ──► MCP idea_list (full) ──► idea_remove for the ideas that fit this chat ──► builds them

watcher on: any prompt ──► hook ──► background pass ──► claude -p (Haiku) ──► verdicts + a project for each idea

/ideas-find, /ideas-groups ──► hook ──► embedding server (new ideas only) ──► cosine similarity ──► answer
            with sync on  ──► hook ──► ideamine server /api/vectors (it embeds new ideas) ──► cosine similarity here
publish on: any prompt after a change ──► hook ──► background publish ──► PUT index.html + data.json

/ideas-web       ──► hook ──► ideamine serve on 127.0.0.1 ──► the buttons on the page ──► the same archive

sync on: each change ──► outbox ──► ideamine server ──► the archive of every machine ──► copy here
prompt log on: any prompt ──► hook ──► prompt outbox ──► background sync ──► the Prompts tab
```

The plugin contains a Node MCP server with no dependencies, seventeen skills (the slash commands), seven agents (the pipeline), and one hook. The hook answers `/idea`, `/ideas`, and the local `/ideas-*` commands before any API call, and it lets every other prompt through. The hook runs directly, not through a shell, and takes about 130 ms per prompt on Windows. The skills are user-only, so their descriptions add no tokens to your sessions. If the archive cannot be read, the hook lets the prompt through, so the `/idea` skill can still save it with the MCP tool. Your text is never dropped.

## Development

```bash
npm install
```

```bash
npm test
```

The tests use `node:test`, and [fast-check](https://fast-check.dev) for the property tests. fast-check is a development dependency only: the plugin itself installs nothing. The tests cover the store, including concurrent writers from several processes, the hook, the MCP protocol, headless triage with pairing, the watcher, embeddings and groups, and the dashboard upload. Triage runs against a stand-in `claude`, and embeddings and uploads run against a stand-in server, so the tests spend no tokens and need no network.

## More projects

- [SubRead](https://subread.space/): read along with an audiobook, in the browser.
  Also [for Android](https://github.com/equwal/subread-android/releases/latest),
  [for YouTube](https://github.com/equwal/subread-extension/releases/latest)
  and [for KOReader](https://github.com/equwal/subread.koplugin).
- [SubRead Overlay](https://github.com/equwal/subread-overlay/releases/latest): subtitle lines over any Android media player.
- [SubRead Dictionary](https://github.com/equwal/subread-dictionary/releases/latest): a pop-up dictionary for Android that reads Yomitan dictionaries.
- [SubRead Anki](https://github.com/equwal/subread-anki): one tap makes an Anki card from any Android app.
- [Subrep](https://github.com/equwal/subrep-android/releases/latest): live captions of the sound of your phone.
- [Book Simulator](https://booksimulator.com/): a reading room for Aozora Bunko and Project Gutenberg books.
- [honjimaku.com](https://honjimaku.com/): subtitles for Japanese audiobooks.
- [sbm Sync](https://sbmsync.com/): your bookmarks, the same on every device,
  with [sbm](https://github.com/equwal/sbm) for dmenu,
  [sbm for Android](https://github.com/equwal/sbm-android/releases/latest)
  and the [sbm add-on](https://github.com/equwal/sbm-extension/releases/latest) for Firefox and Chrome.
- [Rebind](https://github.com/equwal/rebind/releases): remap the hardware buttons of e-ink readers and Android,
  with [Ink Recents](https://github.com/equwal/ink-recents/releases/latest),
  [Ink Dim](https://github.com/equwal/ink-dim/releases/latest)
  and [Ink Update](https://github.com/equwal/ink-update/releases/latest).
- [dickt.store](https://dickt.store/): language-learning tools, flashcards and web toys.
- [hentaibun.online](https://hentaibun.online/): learn kanbun and kobun.
- [Recently Written](https://recentlywritten.com/): the blog, and a list of [all projects](https://recentlywritten.com/projects.html).

## License

MIT
