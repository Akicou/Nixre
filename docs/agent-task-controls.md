# Agent task controls

The Assistant workspace includes durable task controls. Start a conversation and open the **Task controls** panel above the transcript. Choose the permission preset in the composer before the first message; change settings on an idle conversation later.

| Feature | Behavior |
| --- | --- |
| Live checklist | `update_plan` publishes pending, active, completed, and blocked steps. |
| Change review | `write_file` stages a proposal. Review the unified diff and before/after source, then accept or reject each file. Pending proposals do not change the workspace. |
| Checkpoints and undo | A checkpoint is saved before an editable task and before accepting a file. Manual checkpoints and restores are available while idle. Every restore first saves another checkpoint. |
| Automatic verification | Accepting an edit runs detected test/lint/build scripts when enabled. Checks can also be launched explicitly; agent-requested checks require approval. Exit codes and bounded output are saved. |
| Project memory | User-scoped repository memory survives conversations. Edit it in the panel; the agent can update it with `update_project_memory`. Do not store secrets there. |
| Permission presets | Read only exposes inspection; workspace mode stages edits and requires approval for every arbitrary command; restricted mode stages edits and allows approved checks without arbitrary commands. Existing repository profile restrictions still apply. |
| Browser checks | Chromium visits a local HTTP preview, saves a screenshot, and reports HTTP status, JavaScript errors, and console output. The task panel displays the screenshot. |
| Specialist agents | The lead can delegate bounded frontend/backend/testing/review inspections. Specialists are read-only, have at most eight model rounds, and cannot delegate. Up to six assignments per task. Their reports and usage are retained. |
| Resume | Provider threads and tool outcomes are saved. After a restart, choose **Resume saved task**. Completed tool calls are reused; unknown outcomes become explicit warnings to the model instead of replaying actions. |
| Usage and spending | Reported input/output tokens, estimated cost, and elapsed time appear in the panel. Configure your model's prices and an optional spending limit in settings. Task token/time budgets and main-agent round/tool-call count caps are removed. |

## Review and permissions

The agent proposes files through `write_file`. Arbitrary shell commands can also alter files or publish changes; the workspace preset displays the full command for one-time approval before execution. Deny commands you do not want performed. The restricted preset removes arbitrary shell access. Script execution is not a read-only operation: the **Accept file and run checks** and **Run tests, lint, and build** actions explicitly authorize repository scripts.

Workspace mutation controls are disabled while an agent is running. Finish or stop the task before accepting proposals, restoring files, or running manual checks. Approval decisions remain available during the run. A file changed since its proposal was created cannot be accepted; request a fresh proposal. Inspection tools read the live sandbox when available, so accepted edits are visible to the lead and specialists.

## Storage and recovery

Migration `027_agent_task_controls.sql` adds `agent_task_state` and `agent_project_memory`. Task rows follow conversation deletion; memory belongs to the user and repository. Credentials are not stored in task configuration. Provider credentials continue to come from the existing encrypted provider store.

Checkpoints are stored inside the conversation's Docker volume, outside the repository. They preserve regular-file bytes and executable permissions, include tracked and non-ignored untracked files, and exclude ignored files. They do not modify git commits, branches, or the index. Symlink paths and submodules are rejected. Each snapshot is limited to 2,000 files/20 MiB; the latest 20 are retained. The existing sandbox volume expiry policy still applies, so these are workspace undo points rather than permanent backups.

Thread and journal records are written before tool execution and after completion. A process crash in between may leave an uncertain outcome. Resuming never automatically replays that action: the model is told to inspect current state and ask if the outcome cannot be established. Existing approvals are cancelled on resume. Recovery is explicit, not an automatic restart loop. If Docker workspaces expire, database progress remains but files/checkpoints may no longer be available.

## Verification and browser scope

Verification discovers `test`, `lint`, and `build` scripts in the root and common package directories (`backend`, `ui`, `frontend`, `server`, `client`). Python projects with `pyproject.toml` or `pytest.ini` also run pytest. Each command gets up to 120 seconds and bounded output, with a 10-minute total verification limit. Missing tools, dependencies, or invalid scripts are reported as failures; no checks discovered is reported separately from a pass.

Browser checks require an HTTP URL on localhost, 127.0.0.1, or ::1 inside the sandbox. Start the preview server there first. Cross-origin HTTP requests and service workers are blocked; pages relying on CDNs may show incomplete styling, which is reported via blocked resource counts. The viewport is 1280×800. Screenshots up to 2 MiB are displayed inline. This uses the existing sandbox image's Playwright/Chromium installation.

## Usage and spending

Counts use provider-reported usage, including specialist calls and compaction. Set input/output prices per million tokens for the currently selected model; prices are not fetched automatically. Update prices when changing models. Cost is an estimate and may differ from billing, especially for caching or provider-specific charges. The optional spending limit is checked between model/tool calls; an in-flight request can exceed it. A spending limit of zero disables that budget.

Main agent turns have no task-level token budget, elapsed-time deadline, round ceiling, or tool-call count cap. Token usage, elapsed time, and the complete tool journal are still recorded. Existing conversations ignore their previously saved token/time budgets, including on resume. Use Stop to interrupt a task. Specialist bounds, individual command/check timeouts, and the other tool and sandbox limits still apply.

## Deploying

Apply normal backend migrations and rebuild the core image with `docker compose up -d --build nixre-core`. The committed `ui/dist` contains the panel. Docker, the sandbox image, a configured AI provider, and PostgreSQL are required for end-to-end operation. Live deployment and Docker/browser integration must be checked on the deployment host.
