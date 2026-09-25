// Shared Nixre Actions runtime — one engine per nixre-core process, wired to
// Postgres, the bare repos, Docker and the deployment engine.

import { pool } from '../db/pool.js';
import { decryptSecret } from './ai.js';
import { createActionsEngine } from './actions.js';
import { createPgStore } from './actionsStore.js';
import { git, createDockerRunner } from './actionsDrivers.js';
import * as deployBus from './deployBus.js';
import { deployEngine } from './deployRuntime.js';

export const actionsStore = createPgStore(pool);

export const actionsEngine = createActionsEngine({
  store: actionsStore,
  git,
  runner: createDockerRunner(),
  decryptValue: decryptSecret,
  deploy: {
    start: (serviceId, opts) => deployEngine.startDeployment(serviceId, opts),
    cancel: serviceId => deployEngine.cancelDeployment(serviceId),
    subscribe: deployBus.subscribe,
  },
});
