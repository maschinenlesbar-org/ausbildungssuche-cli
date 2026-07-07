// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { AusbildungApiError, AusbildungParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://rest.arbeitsagentur.de";
const DEFAULT_USER_AGENT = "ausbildungssuche-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://rest.arbeitsagentur.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request (e.g. an API key). */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Request headers that carry credentials and must NOT be forwarded across an
 * origin boundary on a redirect (the classic auth-header-on-redirect leak that
 * fetch/curl --location guard against). Compared case-insensitively.
 */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "cookie"];

/**
 * Strip control characters (C0 controls except tab/newline, DEL, and C1 controls)
 * out of a string that originates in an attacker-controlled response — here the
 * error `detail`. JSON.parse decodes an escaped ESC in an error body into a
 * real ESC byte, so without this a hostile or MITM'd endpoint could drive ANSI/OSC
 * terminal escape sequences (display spoofing, title changes) into the user's
 * terminal when the message is printed raw to stderr by run.ts. The success path
 * is already safe because JSON.stringify escapes control characters, so this only
 * needs to cover text that flows into an error message. Implemented with a
 * code-point filter so no raw control byte appears in this source file.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
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
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    // The per-request `accept` is the authoritative Accept for this call, so it
    // is applied AFTER defaultHeaders — otherwise a default `Accept` (e.g. an
    // API-wide HAL+JSON default) would permanently shadow per-endpoint
    // negotiation. User-Agent is likewise applied after defaultHeaders.
    let headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && redirects < this.maxRedirects) {
        const location = response.headers["location"];
        if (typeof location === "string" && location.length > 0) {
          const current = new URL(url);
          const next = new URL(location, url);
          // SECURITY: when the redirect crosses an origin boundary (different
          // protocol, host, or port), strip credential-bearing headers so we
          // never forward the X-API-Key / Authorization / Cookie — including a
          // user's own private --api-key — to a different host.
          if (next.origin !== current.origin) {
            headers = stripCredentialHeaders(headers);
          }
          url = next.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
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
      throw new AusbildungParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): AusbildungApiError {
    const text = body.toString("utf8");
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
    // (run.ts prints AusbildungApiError.message raw). The success path is already
    // safe because JSON.stringify escapes these characters.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new AusbildungApiError({ status, url, method, body: text, detail });
  }
}
