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
// Resolution is explicit, validates the daemon's identity and core membership,
// and never falls back to the daemon's default bridge on a policy error.

/** Name of the internal database network, never used for spawned containers. */
export const DATA_NETWORK = process.env.NIXRE_DATA_NETWORK || 'nixre-data';

/**
 * The approved network a spawned container should join. Throws on an absent,
 * unsafe, or unreachable network; callers must not swallow this failure.
 *
 * @param {object} [docker]  dockerode instance, used to discover core's networks
 * @param {object} [opts]
 * @param {string} [opts.preferred]  operator-specified network name
 * @param {string} [opts.role]       'sandbox' | 'app' — for log messages
 */
export async function spawnedContainerNetwork(docker, { preferred, role = 'container' } = {}) {
  const configured = String(preferred ?? (role === 'app' ? process.env.NIXRE_APPS_NETWORK : process.env.SANDBOX_NETWORK) ?? '').trim();
  if (!configured || !docker) throw new Error(`Configure an explicit Docker network for ${role} containers`);
  const network = await docker.getNetwork(configured).inspect();
  if (!network.Name || !network.Id ||
      network.Name === DATA_NETWORK || network.Id === DATA_NETWORK ||
      network.Name === 'nixre-data' || network.Name.endsWith('_nixre-data') ||
      network.Labels?.['com.docker.compose.network'] === 'nixre-data' ||
      ['host', 'null'].includes(network.Driver) || ['bridge', 'host', 'none'].includes(network.Name)) {
    throw new Error(`Refusing unsafe ${role} network '${configured}'`);
  }
  const { default: os } = await import('node:os');
  const info = await docker.getContainer(os.hostname()).inspect();
  const memberships = info.NetworkSettings?.Networks || {};
  if (!Object.values(memberships).some(n => n.NetworkID === network.Id)) {
    throw new Error(`Core must be attached to ${role} network '${network.Name}'`);
  }
  return network.Name;
}
