# Repository workspace layouts

Use **Layout** above the workspace to choose:

- **Split view (default):** tree on the left, deployments on the right, selected file or README full width below. Sections stack on small screens.
- **Three columns:** tree, file/README preview, and deployments side by side at every viewport size. Small screens scroll horizontally inside a minimum readable width.
- **Preview left:** large file preview on the left, tree and deployments stacked on the right. On phones the order is preview, tree, deployments.
- **Stacked:** full-width tree, preview, and deployments, vertically at every screen size.

The preference is saved to the signed-in user's account as `repository_layout` through the existing preferences API. It applies across repositories and devices. Guest selections last for the current visit. An unknown value falls back to Split view. Switching layouts rearranges the mounted sections, so expanded folders and editor/deployment drafts are kept.

Folders load on demand. Arrow keys navigate and expand/collapse the tree, and Enter opens a file. Direct file links expand their ancestors. Tree and README requests share a branch-scoped cache. **Refresh files** and successful file commits refresh it.

Deployments are a compact divided service list. Opening a service or creation form can expand the deployment workspace. The expand/restore control and **All services** return to the normal layout. Stacked already uses the full width. The links `?deploys=1`, `?tab=deployments`, `?svc=<id>`, and `?dtab=<tab>` work, and file navigation keeps deployment parameters.

Guests see a sign-in prompt instead of a deployment request. Read-only access allows deployment inspection. Creation and mutation need write access. Empty lists and failed requests have separate states, and failed loads have a retry.

## Browser regression checks

From `ui/`, run `npm run build`, `npx playwright install chromium`, then `npm run test:layouts`. The suite measures real panel positions at desktop, laptop, tablet, and phone widths, including widths below the former 1280px breakpoint. It also covers saved preferences and draft preservation. CI runs it against the production build.
