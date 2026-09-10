# AI assistant — providers, models, usage

The "Nixre Assistant" is an agentic copilot. A **validated provider is required**; there is no offline fallback.

## Activation (two layers)

1. **Server gate** — the operator enables the plugin for the instance.
2. **User toggle** — each user enables it at **Plugins** (`/plugins`). Off by default.

Plugin state, assistant profiles, chat sessions, and passkey vaults are stored server-side in Postgres, so they follow the account across browsers/devices.

## Providers & models

- Add multiple providers (DeepSeek, OpenAI, Anthropic, Ollama, local/custom OpenAI-compatible endpoints). Each is validated against the live provider and its model list fetched automatically.
- In **Plugins → Configure → Edit**, rename an existing provider, change its base URL, or replace its API key. Leave the replacement key blank to retain the stored key. Connection changes are validated before saving; failed validation preserves the existing connection. Enabled models and the default are retained when still available on the updated connection.
- Provider settings use flat sections and divided model lists. Expand **Models** for search and selection; the editor supports saving, retrying after an error, and cancelling without changing the connection.
- Select which models are **enabled for chat** and which provider is **active**. API keys are encrypted server-side and never sent to the browser.
- The **model list picker** has a **search box** and an **all / enabled / disabled** filter, so long lists are easy to navigate.

### Model picking & reasoning

- **Reasoning Level**: none (`magnetar-chat`-type), low/medium/high (`o-series`, `gpt-5`), etc.
- **Interleaved thinking** can be enabled.
- Reasoning arrives under different keys across gateways: `thinking` (Ollama), `reasoning_content` (DeepSeek), `reasoning` (OpenRouter/most), `reasoning_details` (OpenRouter structured), or wrapped in `<think>` tags inside `content`.

> **Known bug (fixed):** some gateways send the same reasoning delta under **two fields in one chunk** (e.g. `reasoning` **and** `reasoning_details`, or `thinking` **and** `reasoning_content`). That made every reasoning token append twice in both the live UI *and* the saved transcript (interleaved "LetLet me solve..."). Fixed in `backend/src/lib/ai.js` (`extractReasoningTexts` now dedupes per source, and a stream-wide flag guards the final-`message` fallback). If you see doubled reasoning, ensure the running `nixre-core` includes this fix.

## Workspace selector

The assistant can work on:
- **Nixre-hosted repos** (cloned on the server), or
- **github.com repos** (via the user's stored GitHub PAT, cloned/mirrored automatically with direct-to-GitHub pushes), or
- an **Unrestricted free-form sandbox** mode.

## Chat modes & tools

- Agent execution runs on the server independently of browser focus. Returning to a tab, reconnecting to the network, or missing 45 seconds of stream activity replaces only the event subscription and reloads a server snapshot; it never resubmits a command.
- A task can be waiting for command/check approval while its run is active. Task controls explicitly show **Waiting for your approval**. Their reads time out and refresh on focus so a suspended request cannot hide the approval indefinitely.
- Command approvals are streamed into the transcript and persisted with the tool call. The tool switches from a spinner to **Approval needed**, displays the full command with **Approve command / Deny command**, and raises an in-app notification. Background tabs also receive a desktop notification when browser permission is already granted. Approval reads and decisions check conversation ownership without provisioning or fetching the GitHub workspace. Stopping a pending approval is reported as cancellation, not as a user denial.

- Modes: **Ask, Plan, Agent, Debug** (streaming chat), configurable reasoning levels.
- The agent can **read files, search code, show images, run shell commands** in a clone of the target repo, and **search the web** — each gated by a **per-repo access profile**.
- Sits on the dashboard and per-repo. Per-repo access profile is configured at **Plugins → Repository Access Profile** (or `mode='full'` form with a repo path).

## Common API endpoints

`ai/providers`, `ai/providers/:id`, `ai/providers/:id/models`, `ai/profile`, `ai/chat`, `ai/tools`, `ai/jobs/:conversationId/events` (SSE), `.../queue`, `.../stop`, `ai/sandbox/touch`, `ai/github/repos`, `conversations`, `conversations/:id`.

> **NaN-style bug pattern:** the assistant run loop and jobs use SSE; a param-naming mismatch between a route (`:id`) and a helper (`req.params.serviceId`) has caused 500s. When a whole route 500s, compare the route param name to the body/helper that reads it.
