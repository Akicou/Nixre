// In-process event bus for deployment runs — build/release log lines, status
// transitions, and metrics samples fan out to SSE subscribers here. Mirrors
// the agentJobs bus pattern; one bus per service, line buffer so late SSE
// joiners get history without re-reading Postgres.
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 500;

/** @type {Map<number, { emitter: EventEmitter, buffer: Array<object> }>} */
const buses = new Map();

export function _resetForTests() {
  buses.clear();
}

function busFor(serviceId) {
  let bus = buses.get(serviceId);
  if (!bus) {
    bus = { emitter: new EventEmitter(), buffer: [] };
    bus.emitter.setMaxListeners(50);
    buses.set(serviceId, bus);
  }
  return bus;
}

// Publish an arbitrary event to everyone watching a service and remember it
// for subscribers that attach mid-run. Bounded buffer avoids unbounded growth
// on chatty builds.
export function publish(serviceId, event) {
  const bus = busFor(serviceId);
  const withTs = { ...event, ts: event.ts ?? Date.now() };
  bus.buffer.push(withTs);
  if (bus.buffer.length > MAX_BUFFER) bus.buffer.splice(0, bus.buffer.length - MAX_BUFFER);
  bus.emitter.emit('event', withTs);
}

// Subscribe returns an unsubscribe fn; replays the buffered tail first.
export function subscribe(serviceId, send) {
  const bus = busFor(serviceId);
  for (const evt of bus.buffer) {
    try {
      send(evt);
    } catch {
      /* subscriber write raced a close — the remove path handles cleanup */
    }
  }
  const onEvent = evt => {
    try {
      send(evt);
    } catch {
      /* ditto */
    }
  };
  bus.emitter.on('event', onEvent);
  return () => bus.emitter.off('event', onEvent);
}

// Convenience emitters used by the pipeline / samplers.
export function publishLog(serviceId, phase, line) {
  publish(serviceId, { type: 'log', phase, line });
}
export function publishStatus(serviceId, status, extra = {}) {
  publish(serviceId, { type: 'status', status, ...extra });
}
export function publishMetrics(serviceId, metrics) {
  publish(serviceId, { type: 'metrics', metrics });
}

export function dropBus(serviceId) {
  buses.delete(serviceId);
}
