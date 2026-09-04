# AI assistant — providers, models, usage

The "Nixre Assistant" is an agentic copilot. A **validated provider is required**; there is no offline fallback.

## Activation (two layers)

1. **Server gate** — the operator enables the plugin for the instance.
2. **User toggle** — each user enables it at **Plugins** (`/plugins`). Off by default.

Plugin state, assistant profiles, chat sessions, and passkey vaults are stored server-side in Postgres, so they follow the account across browsers/devices.

## Providers & models

- Add multiple providers (DeepSeek, OpenAI, Anthropic, Ollama, local/custom OpenAI-compatible endpoints). Each is validated against the live provider and its model list fetched automatically.
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

- Modes: **Ask, Plan, Agent, Debug** (streaming chat), configurable reasoning levels.
- The agent can **read files, search code, show images, run shell commands** in a clone of the target repo, and **search the web** — each gated by a **per-repo access profile**.
- Sits on the dashboard and per-repo. Per-repo access profile is configured at **Plugins → Repository Access Profile** (or `mode='full'` form with a repo path).

## Common API endpoints

`ai/providers`, `ai/providers/:id`, `ai/providers/:id/models`, `ai/profile`, `ai/chat`, `ai/tools`, `ai/jobs/:conversationId/events` (SSE), `.../queue`, `.../stop`, `ai/sandbox/touch`, `ai/github/repos`, `conversations`, `conversations/:id`.

> **NaN-style bug pattern:** the assistant run loop and jobs use SSE; a param-naming mismatch between a route (`:id`) and a helper (`req.params.serviceId`) has caused 500s. When a whole route 500s, compare the route param name to the body/helper that reads it.
