/**
 * D1 access helpers and optional KV acceleration.
 *
 * All SQL in this worker is executed through these helpers so that:
 *   - every statement uses bound parameters (never string concatenation),
 *   - identifiers such as table names come from this codebase only,
 *   - failures are converted into a generic Error that the router maps to a
 *     sanitized HTTP response (no SQL text, no binding names).
 */

/** Wrapper for D1 errors so routes can distinguish storage failures. */
export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

/**
 * Assert that a helper received a D1 binding rather than an `env` wrapper.
 *
 * Passing `env` instead of `env.DB` is an easy mistake to make and produces a
 * confusing "db.prepare is not a function" later on. Failing here instead keeps
 * the cause obvious.
 */
function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    const looksLikeEnv = Boolean(db && typeof db === 'object' && db.DB);
    throw new StorageError(
      looksLikeEnv
        ? 'Received an env object where a D1 binding was expected; pass env.DB'
        : 'D1 binding is missing or malformed',
    );
  }
}

/** Run a statement that returns rows. */
export async function all(db, sql, params = []) {
  requireDb(db);
  try {
    const result = await db.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch (error) {
    throw new StorageError('Query failed', error);
  }
}

/** Run a statement and return the first row or null. */
export async function first(db, sql, params = []) {
  requireDb(db);
  try {
    const result = await db.prepare(sql).bind(...params).first();
    return result || null;
  } catch (error) {
    throw new StorageError('Query failed', error);
  }
}

/** Run a write statement and return its metadata. */
export async function run(db, sql, params = []) {
  requireDb(db);
  try {
    const result = await db.prepare(sql).bind(...params).run();
    return result.meta || {};
  } catch (error) {
    throw new StorageError('Write failed', error);
  }
}

/**
 * Insert a row and return its rowid.
 * Uses the metadata D1 returns with the write result, with a defensive
 * fallback query in case the driver omits it.
 */
export async function insertReturningId(db, sql, params = []) {
  requireDb(db);
  const meta = await run(db, sql, params);
  if (meta && Number.isFinite(meta.last_row_id) && meta.last_row_id > 0) {
    return meta.last_row_id;
  }
  const row = await first(db, 'SELECT last_insert_rowid() AS id');
  return row ? row.id : null;
}

/** Execute several prepared statements in a single D1 batch (transacted). */
export async function batch(db, statements) {
  requireDb(db);
  if (!statements.length) return [];
  try {
    return await db.batch(statements);
  } catch (error) {
    throw new StorageError('Batch write failed', error);
  }
}

/**
 * Atomically increment a per-guild counter and return the new value.
 * The upsert with RETURNING makes concurrent allocations impossible to collide.
 */
export async function nextCounter(db, guildId, counter) {
  requireDb(db);
  const row = await first(
    db,
    `INSERT INTO guild_counters (guild_id, counter, last_value)
     VALUES (?1, ?2, 1)
     ON CONFLICT (guild_id, counter)
       DO UPDATE SET last_value = last_value + 1
     RETURNING last_value`,
    [guildId, counter],
  );
  if (!row || !Number.isFinite(row.last_value)) throw new StorageError('Counter allocation failed');
  return row.last_value;
}

/* ---------------------------------------------------------------------------
 * Optional KV helpers. Every function degrades to a no-op when the KV binding
 * is not configured, so the worker works with or without the namespace.
 * ------------------------------------------------------------------------- */

/** Read a cached JSON value. */
export async function cacheGet(env, key) {
  if (!env.KV) return null;
  try {
    const raw = await env.KV.get(key, 'text');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Write a cached JSON value with a TTL in seconds. TTL 0 disables the write. */
export async function cachePut(env, key, value, ttlSeconds) {
  if (!env.KV || !ttlSeconds || ttlSeconds <= 0) return;
  try {
    await env.KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.min(ttlSeconds, 86400)) });
  } catch {
    // Cache failures must never break a request.
  }
}

/** Delete a cached value. */
export async function cacheDelete(env, key) {
  if (!env.KV) return;
  try {
    await env.KV.delete(key);
  } catch {
    // ignored
  }
}

/**
 * Fixed-window rate limiter backed by KV.
 * Returns {allowed: boolean, remaining: number, retryAfter: number}.
 * Without a KV binding the limiter is permissive; the bot also rate limits
 * its own command usage, so this is defence in depth rather than the only gate.
 */
export async function rateLimit(env, key, limitPerMinute) {
  if (!env.KV || !limitPerMinute || limitPerMinute <= 0) {
    return { allowed: true, remaining: limitPerMinute || 0, retryAfter: 0 };
  }

  const bucket = Math.floor(Date.now() / 60000);
  const namespaced = `rl:${key}:${bucket}`;

  try {
    const raw = await env.KV.get(namespaced, 'text');
    const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
    if (count >= limitPerMinute) {
      const secondsIntoBucket = Math.floor((Date.now() % 60000) / 1000);
      return { allowed: false, remaining: 0, retryAfter: Math.max(1, 60 - secondsIntoBucket) };
    }
    await env.KV.put(namespaced, String(count + 1), { expirationTtl: 120 });
    return { allowed: true, remaining: Math.max(0, limitPerMinute - count - 1), retryAfter: 0 };
  } catch {
    return { allowed: true, remaining: 0, retryAfter: 0 };
  }
}
