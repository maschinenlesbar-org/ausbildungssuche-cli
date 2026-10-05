// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  httpUrlProblem,
  intRangeProblem,
} from "./validate.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  AusbildungApiError,
  AusbildungError,
  AusbildungNetworkError,
  AusbildungParseError,
  AusbildungValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://rest.arbeitsagentur.de";

/** Most retries `maxRetries` may ask for (each may wait up to MAX_RETRY_AFTER_MS). */
export const MAX_RETRIES = 10;

/** Most redirects `maxRedirects` may ask the engine to follow. */
export const MAX_REDIRECTS = 10;
/** The User-Agent sent when none is given. */
export const DEFAULT_USER_AGENT = "ausbildungssuche-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API, an absolute http(s) URL without surrounding whitespace,
   * control characters, query or fragment (baseUrlProblem). Defaults to
   * https://rest.arbeitsagentur.de
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header; defaults to `DEFAULT_USER_AGENT`. Must be a
   * valid header value (headerValueProblem): a blank one is rejected, not replaced.
   */
  userAgent?: string;
  /**
   * Extra headers sent on every request (e.g. an API key). Names must be HTTP
   * tokens and values valid header values (headerNameProblem, headerValueProblem).
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   * Defaults to 30000. Enforced by the engine for every transport: the transport
   * gets an AbortSignal that fires at the deadline.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`; GET/HEAD only), an integer
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits the response's `Retry-After`
   * (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried), or else
   * `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), a non-negative
   * integer; used without a Retry-After. Defaults to 200.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, an integer
   * 0..`MAX_REDIRECTS` (10); defaults to 5. Any other 3xx, one with a missing or
   * malformed Location, and one past this limit surface as an AusbildungApiError
   * naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit. Checked on the body of every transport.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Default per-request time limit in milliseconds (`timeoutMs`). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default cap on a response body in bytes (`maxResponseBytes`), 100 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as an AusbildungApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Request headers that carry credentials and must NOT be forwarded across an
 * origin boundary on a redirect (the classic auth-header-on-redirect leak that
 * fetch/curl --location guard against). Compared case-insensitively.
 */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "cookie"];

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response — the error
 * `detail`, a redirect `Location` — safe to print into an error message on stderr
 * (run.ts prints AusbildungApiError.message raw):
 *
 * - C0 and C1 controls and DEL are dropped. A JSON error body can encode an escape
 *   (U+001B) that JSON.parse turns into a real control byte; printed raw, a hostile
 *   or MITM'd endpoint could drive ANSI/OSC sequences into the terminal (display
 *   spoofing, title changes).
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL, C1 and bidi characters raw.
 * Written as a char-code filter so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Check a base URL (baseUrlProblem) and return it with trailing slashes stripped,
 * or throw an AusbildungValidationError (`Invalid baseUrl: <reason>`). The default
 * transport still gates the scheme on every hop (redirects included); this gate
 * covers a library consumer's custom transport, which does no such check.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * A numeric engine option: `fallback` when undefined, else an integer in 0..max,
 * or an AusbildungValidationError (`Invalid <name>: ...`). Exported so side
 * fetchers (obtainKey) apply the same rule.
 */
export function intOption(name: string, value: number | undefined, max: number, fallback: number): number {
  return value === undefined ? fallback : assertValid(name, value, intRangeProblem(0, max));
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) {
    return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  }
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. A string is read as UTF-8. Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    return Buffer.from(value as ArrayBuffer);
  }
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names, as the engine reads
 * them. A transport built on `fetch` naturally returns its `Headers` object, which
 * passes as an object but has no plain properties: the engine then saw no
 * Retry-After and no Location at all. Such an object (anything with `get` and
 * `forEach`, a `Map` included) is copied into a record; a plain record gets its names
 * lower-cased (Node's transport does that already, a custom one may not).
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  const record: Record<string, string | string[] | undefined> = {};
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** A single header value (the first of a repeated one), or undefined. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a failure caused by a reset or aborted connection (`ECONNRESET`, `EPIPE`,
 * `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the `cause` chain), which the
 * engine retries like a 503 — whichever transport raised it. A refused connection, a
 * DNS failure or a timeout is not transient in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return hasTransientCode(err);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Return a copy of `headers` with any credential-bearing header removed. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.includes(key.toLowerCase())) out[key] = value;
  }
  return out;
}

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL or
  // the API key in the default headers can't be logged by accident.
  readonly #baseUrl: string;
  readonly #defaultHeaders: Record<string, string>;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /** Secrets without an `@` to anchor on (the API key), for the same scrubbing. */
  readonly #secrets: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Checked on the raw value, before the trailing-slash strip; only `undefined`
    // selects the default.
    this.#baseUrl = options.baseUrl === undefined ? DEFAULT_BASE_URL : validateBaseUrl(options.baseUrl);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Header values are checked here, not only by the CLI: a CR/LF would reach a
    // custom transport as an injected header, and the default transport would fail
    // late with a raw TypeError. Only `undefined` selects the default User-Agent.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid("header name", name, headerNameProblem);
      assertValid(`header ${name}`, value, headerValueProblem);
    }
    // The secret part of a credential header (`Bearer <token>` → the token; an
    // X-API-Key as it is), never echoed.
    this.#secrets = Object.entries(this.#defaultHeaders)
      .filter(([name]) => CREDENTIAL_HEADERS.includes(name.toLowerCase()))
      .map(([, value]) => value.replace(/^\S+\s+/, "").trim());
    // Range-check the numeric options: a negative, NaN or fractional value would
    // otherwise silently disable the timeout or the size cap, and an unbounded
    // maxRetries would keep retrying.
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, Number.MAX_SAFE_INTEGER, 200);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, MAX_REDIRECTS, 5);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws an AusbildungValidationError for a path with a "." or ".." segment,
   * percent-encoded forms included ("%2e", ".%2e", "%2E%2E"). URL parsing resolves
   * either form as a dot segment, so a path built from `..` would request `/pc/v1/`
   * with the X-API-Key attached. `details` already accepts digits-only ids
   * (offerIdProblem); this is the backstop for every other caller of the engine.
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => /^(?:\.|%2e){1,2}$/i.test(s));
    if (dotSegment !== undefined) {
      throw new AusbildungValidationError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    return this.send(method, this.buildUrl(path, options.query), options.accept);
  }

  /**
   * GET an absolute http(s) URL, outside the base URL, with the same request policy
   * as every other request: timeout, size cap, 429/503 retries, redirects with
   * credential stripping, and the User-Agent and default headers. Used by
   * obtainKey(), which builds an engine without an API key. Rejects with an
   * AusbildungValidationError for a URL that is not http(s) (httpUrlProblem).
   */
  async getAbsolute(url: string, accept: string): Promise<RawResponse> {
    assertValid("url", url, httpUrlProblem);
    return this.send("GET", url, accept);
  }

  private async send(method: string, initialUrl: string, accept: string): Promise<RawResponse> {
    let url = initialUrl;
    // The per-request `accept` is the authoritative Accept for this call, so it
    // is applied AFTER defaultHeaders — otherwise a default `Accept` (e.g. an
    // API-wide HAL+JSON default) would permanently shadow per-endpoint
    // negotiation. User-Agent is likewise applied after defaultHeaders.
    let headers: Record<string, string> = {
      ...this.#defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };

    // Only an idempotent request is sent again: send() is reachable with any method
    // through request(), and a POST re-sent after a reset or a 503 may be applied
    // twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let raw: HttpResponse;
      try {
        raw = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET like one, whichever transport reported it. Timeouts are
        // not retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.toNetworkError(method, url, cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the AusbildungError contract.
      const invalid = responseProblem(raw);
      if (invalid !== undefined) {
        throw new AusbildungNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      const status = raw.status;
      const responseHeaders = plainHeaders(raw.headers);
      const body = bodyBytes(raw.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new AusbildungNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }
      const response = { status, headers: responseHeaders, body };

      const retryable = status === 429 || status === 503;
      if (idempotent && retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL. Only an
      // http(s) target is followed: a file:, data: or javascript: one never reaches the
      // transport, and surfaces below as an AusbildungApiError naming it.
      const location = headerValue(response.headers["location"]);
      const target =
        FOLLOWED_REDIRECTS.has(status) && redirects < this.maxRedirects
          ? resolveLocation(location, url)
          : undefined;
      const next = target !== undefined && /^https?:$/.test(target.protocol) ? target : undefined;
      if (next !== undefined) {
        // SECURITY: when the redirect crosses an origin boundary (different
        // protocol, host, or port), strip credential-bearing headers so we
        // never forward the X-API-Key / Authorization / Cookie — including a
        // user's own private --api-key — to a different host.
        if (next.origin !== new URL(url).origin) {
          headers = stripCredentialHeaders(headers);
        }
        url = next.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, no usable Location, or past
      // maxRedirects — falls through and surfaces as an AusbildungApiError naming
      // the target.

      const contentType = String(headerValue(response.headers["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location);
      }

      return { data: response.body, contentType, status };
    }
  }

  /**
   * `text` without the base URL's credentials or the API key: server text (an error
   * body that echoes the request URL or its headers) and transport text (fetch's
   * "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return redactSecrets(redactCredentials(text, this.#credentials), this.#secrets);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original
   * when its text carries no secret, otherwise a copy with them scrubbed (message,
   * `code` and the cause chain kept), so logging the error with its causes can't
   * reveal the base URL's password or the key.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if ((this.#credentials.length === 0 && this.#secrets.length === 0) || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    const stack = cause.stack ?? "";
    if (message === cause.message && inner === cause.cause && this.scrub(stack) === stack) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Call the transport under the request's time limit (`timeoutMs`): the request gets
   * an AbortSignal that fires at the deadline, and the call rejects then whether the
   * transport stops or not — a custom transport (fetch, a node:http wrapper) that
   * ignores `timeoutMs` can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new AusbildungNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A transport failure as an `AusbildungNetworkError`. The default transport rejects
   * with one already (passed through); an injected one may throw anything (a TypeError
   * from fetch, a string, null), which is wrapped naming the request, with the original
   * as `cause`, so every failure stays an `AusbildungError`.
   */
  private toNetworkError(method: string, url: string, cause: unknown): AusbildungError {
    if (cause instanceof AusbildungNetworkError) {
      // The built-in transport's own errors carry no URL; scrub anyway, in case a
      // custom transport built one from a server's text.
      const message = this.scrub(cause.message);
      const inner = this.scrubCause(cause.cause);
      if (message === cause.message && inner === cause.cause) return cause;
      return new AusbildungNetworkError(message, inner === undefined ? undefined : { cause: inner });
    }
    if (cause instanceof AusbildungError) return cause;
    const reason =
      cause instanceof Error && cause.message.trim() !== ""
        ? cause.message
        : typeof cause === "string" && cause.trim() !== ""
          ? cause
          : "the transport failed without a message";
    return new AusbildungNetworkError(`${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`, {
      cause: this.scrubCause(cause),
    });
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. The `accept` header
   * defaults to `application/json` but can be overridden per endpoint (e.g. the
   * search collection serves HAL+JSON and 406s on plain `application/json`).
   */
  async getJson<T>(path: string, query?: QueryParams, accept = "application/json"): Promise<T> {
    const res = await this.request("GET", path, { query, accept });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new AusbildungParseError(`Failed to parse JSON response from ${path}`, { cause: this.scrubCause(cause) });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
  ): AusbildungApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message
    // (run.ts prints AusbildungApiError.message raw). The CLI's JSON output is
    // escaped separately (escapeControlChars in cli/shared.ts).
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new AusbildungApiError({ status, url, method, body: text, detail, location });
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location).trim();
  return clean === "" ? undefined : clean;
}
