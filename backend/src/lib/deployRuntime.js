// Shared deployment runtime singletons — one engine + one central proxy per
// nixre-core process, wired here so routes/server/tests import the same pair.

import { pool } from '../db/pool.js';
import * as drivers from './deployDrivers.js';
import { createDeploymentEngine } from './deployments.js';

export const deployEngine = createDeploymentEngine({ pool, drivers });

/** @type {ReturnType<typeof import('./deployProxy.js').createDeployProxy> | null} */
let activeProxy = null;

export function setDeployProxy(proxy) {
  activeProxy = proxy;
}

export function getDeployProxy() {
  return activeProxy;
}
