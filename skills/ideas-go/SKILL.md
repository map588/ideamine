---
name: ideas-go
description: Build the next ideamine idea, or a given id, on the cheapest Claude model that can do it. New ideas are triaged first. It does not ask questions.
argument-hint: "[id]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_next, mcp__plugin_ideamine_ideamine__idea_update, mcp__plugin_ideamine_ideamine__idea_triage
---

Build one idea with the model recommended for it. Requested idea: $ARGUMENTS (empty means the next idea in the queue). Do not ask the user anything.

The user saves ideas from any session. The triage pairs each idea with its project folder when one fits. Else the project of an idea is only the folder where the user saved it, and that folder can be wrong or gone. Judge by the text of the idea which idea fits this chat, and where it belongs.

1. Call `idea_next` with `triage: true`. Pass `id` if an id is given. The tool triages new ideas first. If it says that the queue is empty, say so in one line and stop. If the triage failed and no idea came back, call `idea_triage` with no verdicts, judge those ideas, save all verdicts in ONE `idea_triage` call with your model name as `by`, and then call `idea_next` again.
2. If no id is given, the tool also returns the whole queue. If an idea in the queue clearly fits this chat (the current project or this conversation), call `idea_next` with its `id`, and build that idea. Else build the first idea.
3. Choose the directory for the build. Use the current project if the idea fits it. Else use the project directory of the idea if it exists and fits the idea (the tool tells if it exists). Else find the project that the idea is about. If you cannot find it, say so in one line and stop.
4. Tell the user the title, the recommended model, and the directory in one line. If the size is L or XL, add one line: `/ideas-pipeline <id>` runs it through the agent pipeline instead. Then call `idea_update` with status "doing" and `project` set to that directory.
5. Give the build to ONE subagent (Agent tool, general-purpose). Set its `model` to the recommended model (haiku, sonnet, opus, or fable). This sends each idea to the cheapest model that can do it. Set `run_in_background` to false. Step 6 must run in this turn, because the permission to use the ideamine tools ends with the turn. In the subagent prompt, include the brief, the original note, and the directory. Tell the subagent to work only in that directory, and to report what it changed and what is left to do.
6. When the subagent returns, call `idea_update`. Use status "done" with a one-line note. If work remains, keep status "doing" and write a note that says what remains. Then summarize in 2-3 lines.
