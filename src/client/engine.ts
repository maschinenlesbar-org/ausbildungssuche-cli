// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
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
  isPlainObject,
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
  cutForMessage,
  echoedCredentialForms,
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
  /** The URL that answered, after any redirects, without userinfo. */
  url: string;
  /**
   * Set when a redirect led to another origin (another scheme, host or port), so the
   * credentials (the API key, the base URL's userinfo) were not sent to the server
   * that answered: the origins before and after that hop.
   */
  credentialsDropped?: CredentialsDropped;
}

/** Where a redirect left the origin the credentials belong to. */
export interface CredentialsDropped {
  /** The origin that received the credentials. */
  from: string;
  /** The other origin the redirect led to, which did not. */
  to: string;
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
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits `retryDelayMs * attempt`, or
   * the response's `Retry-After` when that is longer (up to `MAX_RETRY_AFTER_MS`; a
   * longer one is not retried, and the error names it).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer
   * 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. A Retry-After can lengthen a
   * wait, never shorten it.
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
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: (event: RetryEvent) => void;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
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
 * once, naming the requested wait: retrying early would only land inside the window
 * the server asked us to wait out, and a hostile value must not stall the CLI.
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

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a warning,
 * or `undefined` when they would not: for `https:`, for a
 * URL that does not parse, and for a loopback host (`localhost`, 127.0.0.0/8, `::1`),
 * where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries userinfo,
 * and every phrase in `secrets` (noun phrases such as "the API key"). It never contains
 * a password or key. The CLI logs it as a `WARN` record of `ausbildungssuche.http`
 * (once per run, before the first request).
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
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

/**
 * Longest server text (in characters) kept for an error message (a `detail`). A longer
 * one is cut and ends in "…", so a hostile or buggy body cannot flood stderr or a CI
 * log with one huge line. `AusbildungApiError.body` keeps the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair). */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return cutForMessage(clean, MAX_DETAIL_LENGTH);
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function is an AusbildungValidationError. A string `transport` used to fail at the
 * first request as a raw TypeError, and a bad `sleep` on the first retry.
 */
function functionOption<F>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new AusbildungValidationError(`Invalid ${name}: Expected a function, got ${typeof value}.`);
  }
  return value;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `url` without its userinfo, and the `Authorization: Basic` value the userinfo
 * stands for (undefined without one). The engine attaches credentials per hop
 * itself, so a transport never sees a URL with userinfo: Node's http would turn it
 * into a Basic header on every hop, and `fetch` refuses such a URL. A URL that does
 * not parse is returned as is, for the transport to report.
 */
function splitUserinfo(url: string): { url: string; basic: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, basic: undefined };
  }
  if (parsed.username === "" && parsed.password === "") return { url, basic: undefined };
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const pair = `${decode(parsed.username)}:${decode(parsed.password)}`;
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.href, basic: `Basic ${Buffer.from(pair, "latin1").toString("base64")}` };
}

/** The origin of `url` (scheme, host and port), or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

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
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; anything else must be an object.
    options = options ?? {};
    if (!isPlainObject(options)) {
      throw new AusbildungValidationError("Invalid options: Expected an object of engine options.");
    }
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
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Header values are checked here, not only by the CLI: a CR/LF would reach a
    // custom transport as an injected header, and the default transport would fail
    // late with a raw TypeError. Only `undefined` selects the default User-Agent.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    if (options.defaultHeaders !== undefined && !isPlainObject(options.defaultHeaders)) {
      throw new AusbildungValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid("header name", name, headerNameProblem);
      assertValid(`header ${name}`, value, headerValueProblem);
    }
    // The secret part of a credential header (`Bearer <token>` → the token; an
    // X-API-Key as it is), never echoed. And the forms a server echoes a base URL's
    // userinfo in: the Basic value, the decoded `user:password`, the password alone.
    this.#secrets = Object.entries(this.#defaultHeaders)
      .filter(([name]) => CREDENTIAL_HEADERS.includes(name.toLowerCase()))
      .map(([, value]) => value.replace(/^\S+\s+/, "").trim())
      .concat(credentialsIn(this.#baseUrl).flatMap(echoedCredentialForms))
      // Longest first, so a password never leaves half of the user:password around it.
      .sort((a, b) => b.length - a.length);
    // Range-check the numeric options: a negative, NaN or fractional value would
    // otherwise silently disable the timeout or the size cap, and an unbounded
    // maxRetries would keep retrying.
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    // A longer base delay would outlast any wait the server may ask for, and above
    // 2^31-1 ms Node's timer would fire after 1 ms.
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, MAX_RETRY_AFTER_MS, 200);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, MAX_REDIRECTS, 5);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
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

  /**
   * Send a request, following redirects and retrying transient failures.
   *
   * Credentials — the credential headers (`X-API-Key`, `Authorization`, `Cookie`) and
   * the start URL's userinfo, sent as `Authorization: Basic` unless an Authorization
   * header is already set — are attached by the engine per hop, never baked into the
   * URL the transport sees. They go to the start URL's origin only: a redirect to the
   * same origin (a relative or an absolute `Location`) keeps them, one to another
   * scheme, host or port drops them for the rest of the chain, and the result says
   * so (`credentialsDropped`). The transport is told `redirect: "manual"`; a
   * transport that followed a redirect to another origin itself (its response `url`
   * says so) fails the request instead of being trusted.
   */
  private async send(method: string, initialUrl: string, accept: string): Promise<RawResponse> {
    // The per-request `accept` is the authoritative Accept for this call, so it
    // is applied AFTER defaultHeaders — otherwise a default `Accept` (e.g. an
    // API-wide HAL+JSON default) would permanently shadow per-endpoint
    // negotiation. User-Agent is likewise applied after defaultHeaders.
    const all: Record<string, string> = {
      ...this.#defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };
    const plain = stripCredentialHeaders(all);
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(all)) if (!(name in plain)) credentials[name] = value;
    const start = splitUserinfo(initialUrl);
    if (start.basic !== undefined && !Object.keys(credentials).some((n) => n.toLowerCase() === "authorization")) {
      credentials["Authorization"] = start.basic;
    }
    const hasCredentials = Object.keys(credentials).length > 0;
    const credentialOrigin = originOf(start.url);
    let dropped: CredentialsDropped | undefined;
    let url = start.url;

    // Only an idempotent request is sent again: send() is reachable with any method
    // through request(), and a POST re-sent after a reset or a 503 may be applied
    // twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const sendCredentials = dropped === undefined && originOf(url) === credentialOrigin;
      const headers = sendCredentials ? { ...plain, ...credentials } : plain;
      let raw: HttpResponse;
      try {
        raw = await this.callTransport({
          method,
          url,
          headers,
          redirect: "manual",
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET like one, whichever transport reported it. Timeouts are
        // not retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
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
      // A transport that followed a redirect itself (fetch's default) took the request
      // to a host the engine never checked, credential headers and all: fetch strips
      // Authorization across origins, but not X-API-Key or Cookie. Don't trust it.
      const reported = (raw as { url?: unknown }).url;
      if (typeof reported === "string" && reported !== "" && originOf(reported) !== originOf(url)) {
        throw new AusbildungNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to ` +
            `${originOf(reported) ?? "an unparseable URL"}, another origin. A transport must not ` +
            `follow redirects (HttpRequest.redirect is "manual"); the engine follows them and ` +
            `decides where credentials may go.`,
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
      let retryAfterTooLong: number | undefined;
      if (idempotent && retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After header can ask for
        // longer, never for less: `Retry-After: 0` or a date in the past would turn the
        // retries into a zero-delay burst against a server that has just asked for less
        // load. One beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces
        // at once and names the wait, since retrying sooner would only land inside it.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), url, status);
          continue;
        }
        retryAfterTooLong = retryAfter;
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
        // SECURITY: the credentials (the X-API-Key — a user's own private --api-key
        // included —, the base URL's userinfo as Basic, Authorization, Cookie) belong
        // to the start URL's origin. A redirect to another scheme, host or port drops
        // them for the rest of the chain — http→https on the same host included, as
        // the key must not be re-sent on a hop the user did not choose. A Location's
        // own userinfo is never used.
        next.username = "";
        next.password = "";
        if (hasCredentials && dropped === undefined && next.origin !== credentialOrigin) {
          dropped = { from: originOf(url) ?? "", to: next.origin };
        }
        url = next.href;
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, no usable Location, or past
      // maxRedirects — falls through and surfaces as an AusbildungApiError naming
      // the target.

      const contentType = String(headerValue(response.headers["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location, dropped, retryAfterTooLong);
      }

      return {
        data: response.body,
        contentType,
        status,
        url,
        ...(dropped !== undefined ? { credentialsDropped: dropped } : {}),
      };
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
    const text = decodeBody(res.data, res.contentType, path);
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
    credentialsDropped?: CredentialsDropped,
    retryAfterMs?: number,
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
    if (detail !== undefined) detail = cleanDetail(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new AusbildungApiError({
      status,
      url,
      method,
      body: text,
      detail,
      location,
      ...(credentialsDropped !== undefined ? { credentialsDropped } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy cannot turn a valid answer into
 * a parse error, and an `iso-8859-1` body keeps its umlauts. An unknown charset label
 * is an `AusbildungParseError` naming it and `where`.
 */
export function decodeBody(body: Buffer, contentType: string, where: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new AusbildungParseError(`Unsupported response charset "${cutForMessage(sanitizeServerText(charset))}" from ${where}.`);
  }
  return decoder.decode(body);
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
