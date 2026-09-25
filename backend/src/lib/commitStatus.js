// Commit status helpers shared by the Actions API and the PR merge gate.

/**
 * GitHub's combined state: failure if any status failed or errored, pending
 * if any is still pending, success if all succeeded, 'none' with no statuses.
 */
export function combinedState(statuses) {
  if (!statuses.length) return 'none';
  if (statuses.some(s => s.state === 'failure' || s.state === 'error')) return 'failure';
  if (statuses.some(s => s.state === 'pending')) return 'pending';
  return 'success';
}

/**
 * Why a PR may not merge under "require passing checks", or null if it may.
 * @param {Array<{state:string, context:string}>} statuses  on the PR head
 */
export function mergeBlockReason(statuses) {
  const state = combinedState(statuses);
  if (state === 'none') return 'Checks are required, but none have reported on the latest commit yet';
  if (state === 'pending') return 'Checks are still running on the latest commit';
  if (state === 'failure') {
    const failed = statuses.filter(s => s.state === 'failure' || s.state === 'error').map(s => s.context);
    return `Required checks failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', ...' : ''}`;
  }
  return null;
}
