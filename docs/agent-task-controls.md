# Agent task controls

The Assistant workspace has a **Task controls** panel above the transcript. Choose the permission preset in the composer before the first message. Change settings later on an idle conversation.

| Feature | Behavior |
| --- | --- |
| Live checklist | `update_plan` publishes pending, active, completed, and blocked steps. |
| Change review | `write_file` stages a proposal. Review the unified diff and before/after source, then accept or reject each file. Pending proposals do not change the workspace. |
| Checkpoints and undo | A checkpoint is saved before an editable task and before accepting a file. Manual checkpoints and restores are available while idle. Every restore first saves another checkpoint. |
| Automatic verification | Accepting an edit runs detected test/lint/build scripts when enabled. Checks can also be launched explicitly; agent-requested checks need approval. Exit codes and bounded output are saved. |
| Project memory | User-scoped repository memory persists across conversations. Edit it in the panel; the agent can update it with `update_project_memory`. Do not store secrets there. |
| Permission presets | Read only: inspection tools only. Workspace: stages edits, and every arbitrary command needs approval. Restricted: stages edits, allows approved checks, no arbitrary commands. Repository profile restrictions still apply. |
| Browser checks | Chromium visits a local HTTP preview, saves a screenshot, and reports HTTP status, JavaScript errors, and console output. The panel shows the screenshot. |
| Specialist agents | The lead can delegate frontend/backend/testing/review inspections, up to six assignments per task. Specialists are read-only, get at most eight model rounds, and cannot delegate. Their reports and usage are kept. |
| Resume | Provider threads and tool outcomes are saved. After a restart, choose **Resume saved task**. Completed tool calls are reused. Unknown outcomes become warnings to the model instead of being replayed. |
| Usage and spending | The panel shows tokens, estimated cost, and elapsed time. Prices and an optional spending limit are set in settings. |

## Review and permissions

Shell commands can change files or publish changes, so the workspace preset shows the full command for one-time approval. The restricted preset has no arbitrary shell access. **Accept file and run checks** and **Run tests, lint, and build** authorize repository scripts.

Accepting proposals, restoring files, and running manual checks are disabled while an agent runs. Approval decisions stay available. A file changed since its proposal was created cannot be accepted; request a new proposal. Inspection tools read the live sandbox, so accepted edits are visible to the lead and specialists.

## Storage and recovery

Migration `027_agent_task_controls.sql` adds `agent_task_state` and `agent_project_memory`. Task rows are deleted with their conversation. Memory belongs to the user and repository. Credentials are not stored in task configuration; they come from the existing encrypted provider store.

Checkpoints live in the conversation's Docker volume, outside the repository. They keep regular-file bytes and executable permissions for tracked and non-ignored untracked files. Ignored files are excluded. Git commits, branches, and the index are untouched. Symlink paths and submodules are rejected. Each snapshot is limited to 2,000 files/20 MiB, and the latest 20 are kept. Sandbox volume expiry still applies, so checkpoints are not backups.

Thread and journal records are written before tool execution and after completion. A crash in between can leave an uncertain outcome. Resume never replays that action: the model is told to inspect current state and ask if it cannot establish the outcome. Approvals are cancelled on resume. If Docker workspaces expire, database progress remains but files and checkpoints may be gone.

## Verification and browser scope

Verification finds `test`, `lint`, and `build` scripts in the root and in `backend`, `ui`, `frontend`, `server`, and `client`. Python projects with `pyproject.toml` or `pytest.ini` also run pytest. Each command gets up to 120 seconds and bounded output. Total verification is limited to 10 minutes. Missing tools, missing dependencies, and invalid scripts are reported as failures. "No checks discovered" is reported separately from a pass.

Browser checks need an HTTP URL on localhost, 127.0.0.1, or ::1 inside the sandbox, so start the preview server there first. Cross-origin HTTP requests and service workers are blocked. Pages that rely on CDNs may look unstyled, which shows up in the blocked resource counts. The viewport is 1280×800. Screenshots up to 2 MiB are shown inline. Checks use the Playwright/Chromium install in the sandbox image.

## Usage and spending

Counts use provider-reported usage, including specialist calls and compaction. Set input/output prices per million tokens for the selected model. Prices are not fetched, so update them when you change models. Cost is an estimate and can differ from billing. The spending limit is checked between model and tool calls, so an in-flight request can exceed it. A limit of zero disables the budget.

Main agent turns have no token budget, time deadline, round ceiling, or tool-call cap. Usage, elapsed time, and the tool journal are still recorded. Existing conversations ignore previously saved token/time budgets, including on resume. Use Stop to interrupt a task. Specialist bounds, per-command and per-check timeouts, and other tool and sandbox limits still apply.

## Deploying

Apply the normal backend migrations and rebuild the core image with `docker compose up -d --build nixre-core`. The committed `ui/dist` contains the panel. End-to-end use needs Docker, the sandbox image, a configured AI provider, and PostgreSQL. Check Docker and browser integration on the deployment host.
