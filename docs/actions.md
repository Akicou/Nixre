# Nixre Actions (CI/CD)

Nixre runs workflows from your repository, like GitHub Actions and Gitea Actions. Nothing extra to install: the runner is built into `nixre-core` and runs each job in a throwaway Docker container.

## Where workflows live

Workflow files are YAML in the first of these directories that contains any `.yml`/`.yaml` file:

1. `.nixre/workflows/`
2. `.gitea/workflows/`
3. `.github/workflows/`

So a repository mirrored from GitHub or Gitea usually works as-is, as long as its steps are `run:` commands (see [limits](#whats-not-supported)).

## A first workflow

```yaml
# .nixre/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest        # the default image, node:22-bookworm
    steps:
      - uses: actions/checkout@v4 # optional: the repo is already checked out
      - run: npm ci
      - run: npm test
```

Push it, open the repository's **Actions** tab, and watch the run.

## Triggers

| Event | Filters | Notes |
|---|---|---|
| `push` | `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore` | Branch and tag pushes over HTTPS, SSH and web edits. Deleting a branch runs nothing. |
| `pull_request` | `branches` (the base branch), `paths`, `types` | Types: `opened`, `synchronize` (a push to the PR's branch), `reopened`. Runs on the PR head commit. |
| `schedule` | `- cron: '30 2 * * *'` | Five-field cron, UTC, runs on the default branch. |
| `workflow_dispatch` | `inputs` (`string`, `boolean`, `choice`, `number`) | Adds a **Run workflow** button for people with write access. |

Filters follow GitHub's rules: `*` matches within a path segment, `**` across segments, `!pattern` negates, and the last matching pattern wins. With only `tags:` a branch push does not trigger; with only `branches:` a tag push does not.

## Jobs

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - id: meta
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"
  test:
    needs: build
    strategy:
      fail-fast: true
      matrix:
        node: [20, 22]
        include:
          - node: 22
            coverage: true
    container: node:${{ matrix.node }}
    timeout-minutes: 20
    steps:
      - run: npm ci && npm test
      - if: ${{ matrix.coverage }}
        run: npm run coverage
```

Supported per job: `name`, `runs-on`, `container` (string or `{ image, env }`), `needs`, `if`, `env`, `strategy.matrix` (with `include`/`exclude`), `strategy.fail-fast`, `timeout-minutes`, `continue-on-error`, `outputs`.

**Images.** `ubuntu-latest`, `ubuntu-22.04`, `linux` and similar labels use `NIXRE_ACTIONS_DEFAULT_IMAGE` (default `node:22-bookworm`: Debian with git, curl, Python 3 and build tools). `runs-on: nixre-sandbox` uses the assistant sandbox image (adds ripgrep, pytest, Playwright/Chromium). Any image reference works directly: `runs-on: python:3.12` or `container: rust:1`.

Jobs run in dependency order; a job whose `needs` did not all succeed is skipped unless its `if:` uses `always()` or `failure()`.

## Steps

Supported: `run`, `name`, `id`, `if`, `env`, `shell` (`bash`, `sh`, `python`, `node`), `working-directory`, `continue-on-error`, `timeout-minutes`.

`run` steps use `bash -eo pipefail` when the image has bash, otherwise `sh -e`. The workspace is `/workspace`: a real git checkout of the commit (with `.git`), and `origin` points at this instance when `NIXRE_PUBLIC_URL` is set.

Files for passing data between steps work as on GitHub:

- `$GITHUB_OUTPUT` for `steps.<id>.outputs.<name>`
- `$GITHUB_ENV` for environment variables in later steps
- `$GITHUB_PATH` for directories to prepend to `PATH`

Environment available in every step: `CI=true`, `GITHUB_ACTIONS=true`, `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_REF_TYPE`, `GITHUB_EVENT_NAME`, `GITHUB_ACTOR`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_WORKFLOW`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `GITHUB_WORKSPACE`, `GITHUB_SERVER_URL`, `RUNNER_OS`, plus `NIXRE_*` equivalents.

### Built-in actions

| `uses:` | What it does |
|---|---|
| `actions/checkout@*` | Nothing to do: the repository is already checked out. Accepted so existing workflows run. |
| `nixre/deploy@v1` | Releases one of this repository's [deploy services](deployments-runtime.md) at the run's commit and waits until it is live. `with: service: <name>`; add `wait: false` to fire and forget. |

A continuous-delivery pipeline is therefore just:

```yaml
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci && npm test
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: nixre/deploy@v1
        with:
          service: web
```

Turn off the service's own auto-deploy if you use this, or every push deploys twice.

## Expressions

`${{ }}` works in `run`, `env`, `with`, `if`, `runs-on`, `container`, job `outputs` and `working-directory`.

- Contexts: `github`, `env`, `secrets`, `inputs`, `matrix`, `needs`, `steps`, `job`, `runner`, `strategy`, `vars`.
- Operators: `== != < <= > >= && || !` and parentheses. String comparison ignores case, as on GitHub.
- Functions: `success()`, `failure()`, `cancelled()`, `always()`, `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`.

## Secrets

**Settings → Actions → Secrets** stores per-repository secrets. They are encrypted with the instance key (re-encrypted on key rotation like every other secret), can be replaced but never read back, and every occurrence of a secret value in a log is replaced by `***`. Use them as `${{ secrets.NAME }}`.

## Checks, required checks and badges

Every job reports a commit status named `<workflow> / <job> (<event>)`. Pull requests show the checks of their head commit.

**Settings → Actions → Require passing checks before merging** turns on branch protection: a pull request only merges when every status on its latest commit is green. At least one status must have reported.

External CI can report too, with a personal access token that has write access:

```bash
curl -X POST -H "Authorization: Bearer $NIXRE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"state":"success","context":"jenkins","description":"All good","target_url":"https://ci.example.com/42"}' \
  https://git.example.com/api/v1/repos/acme/web/+/statuses/<full-sha>
```

Status badges for a README:

```markdown
![CI](https://git.example.com/api/v1/repos/acme/web/+/actions/badge.svg?workflow=ci.yml&branch=main)
```

The Actions tab shows a copy-ready snippet for each workflow. Badges of private repositories are only visible to members.

## Running jobs safely

- Each job gets a fresh container, removed when the job ends. A job cannot see other jobs, the Docker socket or the database network. It joins `NIXRE_ACTIONS_NETWORK` (default: the apps network), with outbound internet for package installs.
- Containers drop `NET_RAW`, `MKNOD` and `AUDIT_WRITE`, run with `no-new-privileges`, and are capped by `NIXRE_ACTIONS_MEMORY`, `NIXRE_ACTIONS_CPUS` and a PID limit.
- Workflows run code from the repository, so anyone who can push can run code in a job and read that repository's secrets. That is the same trust as deploy services. Pull requests only come from branches of the same repository, whose authors already have write access.
- `NIXRE_ACTIONS_CONCURRENCY` jobs run at once across the instance; others queue.
- A restart of `nixre-core` marks unfinished runs as failed ("Interrupted by a restart") and removes their containers.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NIXRE_PUBLIC_URL` | empty | Base URL for check links and the checkout's `origin` remote. |
| `NIXRE_ACTIONS_NETWORK` | apps network | Docker network for job containers. Refused if it is the database network. |
| `NIXRE_ACTIONS_CONCURRENCY` | `2` | Jobs running at once. |
| `NIXRE_ACTIONS_DEFAULT_IMAGE` | `node:22-bookworm` | Image for `ubuntu-latest` and friends. |
| `NIXRE_ACTIONS_MEMORY` | `4g` | Memory limit per job. |
| `NIXRE_ACTIONS_CPUS` | `2` | CPU limit per job. |
| `NIXRE_ACTIONS_PIDS_LIMIT` | `2048` | Process limit per job. |
| `NIXRE_ACTIONS_JOB_TIMEOUT_MIN` | `60` | Default job timeout. |
| `NIXRE_ACTIONS_MAX_TIMEOUT_MIN` | `360` | Cap for `timeout-minutes`. |

## What's not supported

Nixre is honest about the gaps instead of silently skipping them. A workflow using any of these fails with a message naming the problem:

- Marketplace actions other than `actions/checkout` and `nixre/deploy` (`actions/setup-node`, `actions/cache`, ...). Pick an image that has the tool instead (`container: node:20`), or install it in a `run` step.
- `services:` containers, reusable workflows (`uses:` on a job), and a matrix built from an expression.
- Events other than the four above.

## API

All under `/api/v1/repos/{space}/{repo}/+`. Reads follow repository visibility (guests can read public repositories); writes need write access.

| Method | Path | |
|---|---|---|
| GET | `/actions/workflows?ref=` | Workflows at a ref, with parse errors |
| GET | `/actions/runs?workflow=&branch=&event=&page=` | Runs, newest first |
| GET | `/actions/runs/{n}` | Run and its jobs |
| GET | `/actions/runs/{n}/jobs/{id}/log` | Job log (text) |
| GET | `/actions/runs/{n}/events` | Live events (SSE) |
| POST | `/actions/runs/{n}/cancel` | Cancel |
| POST | `/actions/runs/{n}/rerun` | Run again for the same commit |
| POST | `/actions/dispatch` | `{workflow, ref, inputs}` |
| GET | `/actions/badge.svg?workflow=&branch=&label=` | Status badge |
| GET/PUT/DELETE | `/actions/secrets[/{name}]` | Secret names; `{value}` to set |
| GET | `/commits/{sha}/status` | Combined status |
| POST | `/statuses/{sha}` | `{state, context, description, target_url}` |
| GET | `/pullreq/{n}/checks` | Checks on a PR head |
