# Repository workspace layouts

The repository Code view shows an expandable file tree and deployments immediately. Repository metadata and clone controls live in a compact header.

Use **Layout** above the workspace to choose:

- **Split view (default):** tree on the left, deployments on the right, and the selected file or README across the full width below.
- **Three columns:** tree, file/README preview, and deployments side by side at every viewport size. On small screens, the workspace scrolls horizontally instead of silently reverting to Split view.
- **Preview left:** a large file preview on the left, with the tree and deployments stacked in a right-hand column. On phones, the preview appears first, followed by the tree and deployments.
- **Stacked:** full-width tree, preview, and deployments arranged vertically at every screen size.

Split view stacks its sections on small screens. The saved preference always controls the selected arrangement; Three columns uses a minimum readable width inside its own horizontal scroller.

The preference is saved to the signed-in user's account under `repository_layout` through the existing preferences API. It applies across repositories and devices. Guest selections last for the current visit. An unknown preference falls back to Split view. Layout switches rearrange the mounted sections, preserving expanded folders and editor/deployment drafts.

Folders load on demand. Arrow keys navigate and expand/collapse the tree; Enter opens a file. Direct file links expand their ancestors. Tree and README requests share a branch-scoped cache; **Refresh files** and successful file commits refresh it.

Deployments use a compact divided service list. Opening a service or creation form can expand the deployment workspace; the expand/restore control and **All services** return to the normal layout. Stacked already uses the full width. Existing `?deploys=1`, `?tab=deployments`, `?svc=<id>`, and `?dtab=<tab>` links work. File navigation preserves deployment parameters.

Guests see a sign-in prompt rather than an authenticated deployment request. Read-only repository access offers deployment inspection; creation and mutation controls require write access. Empty lists and failed requests have separate states, with a retry for failed loads.

## Browser regression checks

From `ui/`, run `npm run build`, `npx playwright install chromium`, then `npm run test:layouts`. The suite measures real panel positions at desktop, laptop, tablet, and phone widths, including widths below the former 1280px breakpoint. It also covers saved preferences and draft preservation. CI runs this suite against the production build.
