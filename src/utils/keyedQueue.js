'use strict';

/** Serialize read/modify/write work by key in this bot process. Not a distributed lock. */
function createKeyedQueue() {
  const tails = new Map();
  return async function run(key, work) {
    const previous = tails.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    tails.set(key, next);
    try {
      return await next;
    } finally {
      if (tails.get(key) === next) tails.delete(key);
    }
  };
}

module.exports = { createKeyedQueue };
