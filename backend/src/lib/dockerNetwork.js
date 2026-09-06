// Docker network selection for containers core spawns on a user's behalf
// (agent sandboxes and deployed app containers).
//
// Why this exists: both call sites used to do
// `Object.keys(container.NetworkSettings.Networks)[0]` — "whichever network
// core happens to list first". Key order is not guaranteed, and after the
// database was moved onto its own internal network that expression had a
// coin-flip chance of returning the DATABASE network. A container running
// user-supplied code would then be attached directly to Postgres.
//
// Creating a deployment only requires write access to a space, so that was a
// straight path from "ordinary member of any space" to "read/write every
// table in the instance".
//
// Resolution is now explicit and refuses the data network outright.

/** Name of the internal database network, never used for spawned containers. */
export const DATA_NETWORK = process.env.NIXRE_DATA_NETWORK || 'nixre-data';

/**
 * The network a spawned container should join, or '' when it cannot be
 * determined (callers then fall back to the daemon default).
 *
 * @param {object} [docker]  dockerode instance, used to discover core's networks
 * @param {object} [opts]
 * @param {string} [opts.preferred]  operator-specified network name
 * @param {string} [opts.role]       'sandbox' | 'app' — for log messages
 */
export async function spawnedContainerNetwork(docker, { preferred, role = 'container' } = {}) {
  const configured = String(preferred ?? process.env.SANDBOX_NETWORK ?? '').trim();
  if (configured) {
    if (configured === DATA_NETWORK) {
      console.error(
        `[dockerNetwork] refusing to attach ${role} containers to the database network ` +
          `('${DATA_NETWORK}'). Check SANDBOX_NETWORK / NIXRE_APPS_NETWORK.`,
      );
      return '';
    }
    return configured;
  }

  if (!docker) return '';
  try {
    const { default: os } = await import('node:os');
    const info = await docker.getContainer(os.hostname()).inspect();
    const networks = Object.keys(info.NetworkSettings?.Networks || {});
    const safe = networks.filter(n => n !== DATA_NETWORK);
    if (networks.length && !safe.length) {
      console.warn(
        `[dockerNetwork] core is only attached to '${DATA_NETWORK}'; refusing to put ` +
          `${role} containers there. Set the network name explicitly.`,
      );
    }
    return safe[0] || '';
  } catch {
    // Not containerized, or docker unreachable — caller falls back.
    return '';
  }
}
