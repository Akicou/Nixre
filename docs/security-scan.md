# Security scan and issues

Nixre scans itself. Every 3 hours (admin setting, 1-168h) nixre-core inventories `nixre-core` and every running deployment, checks the result against known CVEs, and has your configured assistant model decide what actually threatens the live apps. It files repository issues with the fix, or dispatches a rebuild workflow.

On by default. Admin → Security scan shows a countdown to the next scan. It needs no new credentials: it uses an admin's existing **Assistant provider** (Plugins). Pick a specific provider/model under **Admin → Security scan**, or leave it on the admin's default. With no provider configured the scan still runs and keeps its report, but files nothing.

## What a scan does

1. **Inventory** through the Docker API, one fixed read-only command at a time (`node -v`, `npm ls --all --json`, `pip list`, `cat /etc/os-release`, `apk info -v`, `dpkg-query`, ...). The list is an exact-match allowlist in `backend/src/lib/securityScan.js`. There is no shell, so nothing outside it can run, including commands the model proposes.
2. **CVE lookup**: packages go to [OSV](https://osv.dev) (npm, PyPI, Alpine, Debian). Node.js itself is compared with nodejs.org's release index, which marks security releases.
3. **Change check**: findings are hashed. If nothing changed since the last scan, the model is not called (reported as *skipped*), so a quiet instance costs nothing.
4. **Triage** by the model, which sees the findings, which apps are public, and can run the allowlisted commands to verify. It may only:
   - `create_issue` in a repo that owns a scanned deployment (plus the optional *instance repo* for `nixre-core` findings). One issue per root cause; a rerun finds its issue again and reopens it if it was closed while the problem persists.
   - `list_workflows` / `dispatch_workflow` for a `workflow_dispatch` workflow in those repos (max 3 per scan), e.g. to rebuild an image on a patched base.

Issues are authored by the admin whose provider was used and carry a *security scan* badge. Advisory text and container output are treated as untrusted data in the prompt.

## Limits

- Only running containers with a shell-less exec of the allowlisted tools are inventoried; distroless or scratch images yield no packages.
- OSV covers language packages and Alpine/Debian packages, not every distro.
- The scan reads container state. It never changes a container; remediation is an issue or a workflow you own.

## API

`GET/PUT /api/v1/admin/security-scan`, `POST /admin/security-scan/run`, `GET /admin/security-scan/runs/:id` (admin only).

Issues: `GET/POST /api/v1/repos/:space/:repo/+/issues`, `GET/PATCH /issues/:number`, `POST /issues/:number/comments`. Reads follow repo visibility; writes need space membership.
