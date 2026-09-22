---
name: ideas-pipeline
description: Build the next ideamine idea, or a given id, through the agent pipeline (research, storyboard, plan, engineers, test, validate) of the agent-pipeline plugin. For big ideas. New ideas are triaged first.
argument-hint: "[id]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_next, mcp__plugin_ideamine_ideamine__idea_update, mcp__plugin_ideamine_ideamine__idea_triage
---

Run one idea through the agent pipeline. Requested idea: $ARGUMENTS (empty means the next idea in the queue).

The pipeline is the `pipeline` skill of the agent-pipeline plugin (`agent-pipeline:pipeline` in the skill list). If that skill is not available, say so in one line and stop, before you change any idea.

The user saves ideas from any session. The triage pairs each idea with its project folder when one fits. Else the project of an idea is only the folder where the user saved it, and that folder can be wrong or gone. Judge by the text of the idea which idea fits this chat, and where it belongs.

1. Call `idea_next` with `triage: true`. Pass `id` if an id is given. The tool triages new ideas first. If it says that the queue is empty, say so in one line and stop. If the triage failed and no idea came back, call `idea_triage` with no verdicts, judge those ideas, save all verdicts in ONE `idea_triage` call with your model name as `by`, and then call `idea_next` again.
2. If no id is given, the tool also returns the whole queue. If an idea in the queue clearly fits this chat (the current project or this conversation), call `idea_next` with its `id`, and take that idea. Else take the first idea.
3. Choose the project directory. Use the current project if the idea fits it. Else use the project directory of the idea if it exists and fits the idea (the tool tells if it exists). Else find the project that the idea is about. If you cannot find it, say so in one line and stop.
4. Tell the user the title and the directory in one line. Then call `idea_update` with status "doing", `project` set to that directory, and the note "pipeline: started".
5. Invoke the `pipeline` skill with this request, in this shape:

   ```
   Build idea #<id> from my ideamine archive: <title>
   <brief>
   My original note: <text>
   Project: <directory>
   ideamine idea id: <id>
   ```

   The pipeline records a note on the idea after each phase and marks the idea done when its tests and validation pass. It has two gates where it asks the user for approval; that is expected.
6. When the pipeline ends, check the idea with `idea_next` (`id`) or the pipeline's final report. If the pipeline passed and the idea is not yet done, call `idea_update` with status "done" and a one-line note. If work remains, keep status "doing" and write a note that says what remains. Then summarize in 2-3 lines.
