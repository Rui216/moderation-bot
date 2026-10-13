/**
 * Request/response plumbing for the moderation gateway.
 *
 * Security properties enforced here:
 *   - Bearer token comparison is length-independent (no early exit).
 *   - Errors never include stack traces, SQL, binding names, or token values.
 *   - JSON bodies are size limited and parsed defensively.
 *   - No CORS headers are emitted: this API is for the bot only, and browsers
 *     have no legitimate reason to call it.
 */

/** JSON response helper. */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

/** Successful payload wrapper. */
export function ok(data = {}, status = 200) {
  return json({ ok: true, ...data }, status);
}

/**
 * Error payload wrapper. The message must already be safe for transport:
 * no SQL, no identifiers, no binding details.
 */
export function fail(code, message, status = 400, extra = {}) {
  return json({ ok: false, error: { code, message }, ...extra }, status);
}

/** Standard failure responses. */
export const errors = {
  unauthorized: () => fail('UNAUTHORIZED', 'Missing or invalid credentials', 401),
  notFound: () => fail('NOT_FOUND', 'Resource not found', 404),
  methodNotAllowed: () => fail('METHOD_NOT_ALLOWED', 'Method not allowed for this route', 405),
  badRequest: (message = 'Invalid request') => fail('BAD_REQUEST', message, 400),
  invalidPayload: (message = 'Invalid payload') => fail('INVALID_PAYLOAD', message, 422),
  tooLarge: () => fail('PAYLOAD_TOO_LARGE', 'Request body is too large', 413),
  rateLimited: (retryAfterSeconds = 60) => {
    const response = fail('RATE_LIMITED', 'Too many requests', 429);
    response.headers.set('Retry-After', String(retryAfterSeconds));
    return response;
  },
  internal: () => fail('INTERNAL_ERROR', 'The gateway could not complete the request', 500),
};

/**
 * Constant-time string comparison. Length differences are folded into the
 * accumulator instead of returning early.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  const length = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;

  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
  }
  return mismatch === 0;
}

/**
 * Verify the Authorization header against the configured shared secret.
 * @param {Request} request
 * @param {string|undefined} expectedToken
 * @returns {boolean}
 */
export function isAuthorized(request, expectedToken) {
  if (!expectedToken || typeof expectedToken !== 'string' || expectedToken.length < 16) {
    // A misconfigured or trivially short secret must never authorize anything.
    return false;
  }
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (!presented) return false;
  return timingSafeEqual(presented, expectedToken);
}

/**
 * Parse and validate a JSON request body.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ok: true, value: any}|{ok: false, response: Response}>}
 */
export async function readJson(request, maxBytes = 262144) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, response: errors.badRequest('Content-Type must be application/json') };
  }

  const declaredLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, response: errors.tooLarge() };
  }

  let text = '';
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errors.badRequest('Body could not be read') };
  }

  if (text.length > maxBytes) return { ok: false, response: errors.tooLarge() };
  if (!text) return { ok: true, value: {} };

  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: errors.invalidPayload('Body must be a JSON object') };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, response: errors.invalidPayload('Body must be valid JSON') };
  }
}
