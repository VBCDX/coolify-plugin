// Thin fetch client for the Coolify v4 API (§3).
//
// - Builds only routes beneath the configured API origin/prefix; path and query
//   components are encoded here.
// - Bearer auth; TLS verification is never disabled.
// - Redirects are refused, so authentication is never forwarded off-origin.
// - Upstream bodies are capped at 2 MiB before parsing; an oversized or malformed
//   JSON document is an error, not an empty list.
// - One AbortSignal spans the whole call (file read, preflight, mutation,
//   verification); it is not reset per request. There are no automatic retries.

import { MAX_BODY_BYTES } from './contract.js';
import { safePath } from './redact.js';

/**
 * A classified transport/HTTP failure. `kind` lets the caller choose an outcome
 * (a read timeout is `failed`; a mutation timeout is `indeterminate`).
 */
export class HttpError extends Error {
  /** @param {string} kind @param {string} message @param {object} [extra] */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind; // 'timeout' | 'cancelled' | 'network' | 'redirect' | 'too_large' | 'bad_json' | 'http'
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
    this.body = extra.body;
  }
}

/**
 * @typedef {Object} CallDeadline
 * @property {AbortSignal} signal shared for the whole call
 * @property {() => boolean} timedOut whether the shared deadline elapsed
 */

/**
 * A per-call client bound to one API base, one token snapshot, and one deadline.
 */
export class CoolifyClient {
  /**
   * @param {{ apiBase: string, token?: string, deadline: CallDeadline }} opts
   */
  constructor({ apiBase, token, deadline }) {
    this.apiBase = apiBase;
    this.token = token;
    this.deadline = deadline;
  }

  /**
   * Perform one request. `segments` are path components appended (encoded) under
   * the API base; `query` is an object of query parameters.
   *
   * @param {{
   *   method: string,
   *   segments?: string[],
   *   query?: Record<string, string|number|boolean|undefined>,
   *   body?: unknown,
   *   auth?: boolean,
   *   accept?: string
   * }} spec
   * @returns {Promise<{status:number, ok:boolean, contentType:string, text:string, json:unknown, hasJson:boolean, retryAfter:string|null, path:string}>}
   */
  /**
   * Compute the reported (nonsecret) API path for a request without dispatching
   * it, so every envelope — success or failure — can name the same path.
   *
   * @param {string[]} segments
   * @param {Record<string, string|number|boolean|undefined>} [query]
   * @returns {string}
   */
  pathFor(segments = [], query = {}) {
    const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
    const url = new URL(this.apiBase + (encoded ? '/' + encoded : ''));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
    return url.pathname + (url.search || '');
  }

  async request(spec) {
    const { method, segments = [], query = {}, body, auth = true, accept = 'application/json' } = spec;
    const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
    const url = new URL(this.apiBase + (encoded ? '/' + encoded : ''));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, typeof v === 'boolean' ? String(v) : String(v));
    }
    const path = url.pathname + (url.search || '');

    /** @type {Record<string,string>} */
    const headers = { Accept: accept };
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        redirect: 'manual', // refuse redirects: never forward auth off-origin
        signal: this.deadline.signal,
      });
    } catch (err) {
      if (isAbort(err)) {
        if (this.deadline.timedOut()) {
          throw new HttpError('timeout', 'The call exceeded its time budget.');
        }
        throw new HttpError('cancelled', 'The call was cancelled.');
      }
      // Network/DNS/TLS failure. The message is our own fixed text; we do not
      // pass the raw OS error through.
      throw new HttpError('network', `Could not reach the Coolify instance (${method} ${safePath(path)}).`);
    }

    // Redirect refusal. undici surfaces a manual redirect as an opaque response
    // (status 0) or, on some versions, the raw 3xx.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new HttpError('redirect', `The instance returned a redirect for ${method} ${safePath(path)}; refusing to follow it.`);
    }

    // Enforce the 2 MiB ceiling before parsing.
    const declared = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new HttpError('too_large', 'The upstream response exceeded the 2 MiB limit.', { status: response.status });
    }
    const raw = await this.#readCapped(response);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const retryAfter = response.headers.get('retry-after');

    let json;
    let hasJson = false;
    if (contentType.includes('application/json') && raw.length > 0) {
      try {
        json = JSON.parse(raw);
        hasJson = true;
      } catch {
        throw new HttpError('bad_json', `The instance returned malformed JSON for ${method} ${safePath(path)}.`, {
          status: response.status,
          retryAfter,
        });
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      contentType,
      text: raw,
      json,
      hasJson,
      retryAfter,
      path,
    };
  }

  /**
   * Read a response body as UTF-8, aborting if it exceeds the 2 MiB ceiling even
   * when no content-length was declared.
   *
   * @param {Response} response
   * @returns {Promise<string>}
   */
  async #readCapped(response) {
    if (!response.body) {
      const t = await response.text();
      if (Buffer.byteLength(t, 'utf8') > MAX_BODY_BYTES) {
        throw new HttpError('too_large', 'The upstream response exceeded the 2 MiB limit.', { status: response.status });
      }
      return t;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new HttpError('too_large', 'The upstream response exceeded the 2 MiB limit.', { status: response.status });
        }
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isAbort(err)) {
        if (this.deadline.timedOut()) throw new HttpError('timeout', 'The call exceeded its time budget.');
        throw new HttpError('cancelled', 'The call was cancelled.');
      }
      throw new HttpError('network', 'The upstream response stream failed.', { status: response.status });
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
}

/**
 * Create a shared call deadline. The returned signal aborts when the MCP request
 * is cancelled or when the total budget elapses; `timedOut()` distinguishes the
 * two after the fact.
 *
 * @param {number} timeoutMs
 * @param {AbortSignal} [outer] the MCP request's cancellation signal
 * @returns {{ deadline: CallDeadline, dispose: () => void }}
 */
export function createDeadline(timeoutMs, outer) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  /** @param {Event} [_e] */
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }

  return {
    deadline: { signal: controller.signal, timedOut: () => timedOut },
    dispose() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    },
  };
}
