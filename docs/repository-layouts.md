# Repository workspace layouts

The repository Code view shows an expandable file tree and deployments immediately. Repository metadata and clone controls live in a compact header.

Use **Layout** above the workspace to choose:

- **Split view (default):** tree on the left, deployments on the right, and the selected file or README across the full width below.
- **Three columns:** tree, file/README preview, and deployments side by side on wide desktops (1280px and up). Smaller desktops use the split arrangement, and mobile stacks all three sections.

The preference is saved to the signed-in user's account under `repository_layout` through the existing preferences API. It applies across repositories and devices. Guest selections last for the current visit. An unknown preference falls back to Split view. Layout switches rearrange the mounted sections, preserving expanded folders and editor/deployment drafts.

Folders load on demand. Arrow keys navigate and expand/collapse the tree; Enter opens a file. Direct file links expand their ancestors. Tree and README requests share a branch-scoped cache; **Refresh files** and successful file commits refresh it.

Deployments use a compact divided service list. Opening a service or creation form expands the deployment workspace; the expand/restore control and **All services** return to the normal layout. Existing `?deploys=1`, `?tab=deployments`, `?svc=<id>`, and `?dtab=<tab>` links work. File navigation preserves deployment parameters.

Guests see a sign-in prompt rather than an authenticated deployment request. Read-only repository access offers deployment inspection; creation and mutation controls require write access. Empty lists and failed requests have separate states, with a retry for failed loads.
