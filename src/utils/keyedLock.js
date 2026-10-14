'use strict';

/**
 * Serialize async work per key. Callers that use the same key run one after
 * another in arrival order; different keys run independently.
 *
 * This runs inside a single bot process. The bot is designed to run as one
 * instance, so an in-memory queue is enough to stop two ticket actions in the
 * same server from interleaving their reads and writes.
 */

const tails = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function withLock(key, work) {
  const previous = tails.get(key) || Promise.resolve();

  // Start after the previous holder finishes, whether it succeeded or failed.
  const run = previous.catch(() => null).then(() => work());

  const settled = run.catch(() => null);
  tails.set(key, settled);

  // Drop the entry once nothing else is queued behind this one.
  settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });

  return run;
}

/** Number of keys with work in progress. Used by tests. */
function activeKeys() {
  return tails.size;
}

module.exports = { withLock, activeKeys };
