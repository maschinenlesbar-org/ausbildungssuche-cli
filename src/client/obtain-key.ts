// Obtain the public `X-API-Key` the Ausbildungssuche API requires.
//
// No key ships with this package (see client.ts). the Bundesagentur für Arbeit publishes a
// single static key for public use, and this module reads it at run time from the
// document that publishes it — so a rotated key needs no release of this CLI.
//
// The value is deliberately *public*, not a secret: printing it, putting it in an
// environment variable and showing it to the user are all intended. What this
// module must never do is invent one, or fall back to a stale literal compiled
// into the package.
//
// The fetch goes through the engine (RequestEngine.getAbsolute), so it has the
// same request policy as every other request: the default timeout and size cap,
// 429/503 retries and redirects. It uses no base URL and sends no API key: the key
// lives on another host and does not exist yet. Testable in-process through the
// `Transport` seam, without a network.

import {
  AusbildungApiError,
  AusbildungError,
  AusbildungNetworkError,
  AusbildungParseError,
  AusbildungValidationError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { RequestEngine, decodeBody, type EngineOptions } from "./engine.js";
import { assertValid, httpUrlProblem, isPlainObject } from "./validate.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "AUSBILDUNGSSUCHE_API_KEY";

/** Authoritative, plain-text source of the public key. */
export const KEY_SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/ausbildungssuche-api/main/README.md";

/** `X-API-Key: <value>` as documented in the source's curl examples (every match). */
const KEY_PATTERN = /X-API-Key:\s*([^\s"'`]+)/gi;

/**
 * The shape of a published key, from the source's actual key (`infosysbub-absuche`,
 * and the sibling APIs' `jobboerse-jobsuche`): 8 to 64 characters, letters and digits
 * in runs joined by single `-`, `_` or `.`. A placeholder in brackets, trailing
 * punctuation (`…-absuche,`), a flag (`--help`), a terminal escape or anything
 * outside ASCII cannot match.
 */
const KEY_SHAPE = /^(?=.{8,64}$)[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/;

/** Words that mark a documentation placeholder rather than a key (`YOUR-API-KEY`). */
const PLACEHOLDER = /your|api[-_.]?key|placeholder|example|changeme|x{4,}|<|>/i;

/**
 * True when `value` (as a whole) is shaped like the published key and is not a
 * placeholder: what `obtainKey()` accepts, so a changed or hostile source document
 * can't make it print a guess, a placeholder or a terminal escape as the key.
 */
export function looksLikeApiKey(value: string): boolean {
  return KEY_SHAPE.test(value) && !PLACEHOLDER.test(value);
}

/**
 * Options for obtainKey(): the engine's request policy (transport, timeout,
 * User-Agent, retries, redirects, size cap) with the engine's defaults and range
 * checks, plus the source URL. No base URL and no API key apply.
 */
export interface ObtainKeyOptions
  extends Pick<
    EngineOptions,
    | "transport"
    | "timeoutMs"
    | "userAgent"
    | "maxRetries"
    | "retryDelayMs"
    | "maxRedirects"
    | "maxResponseBytes"
    | "sleep"
  > {
  /** Override the source document (tests, mirrors); an absolute http(s) URL. */
  sourceUrl?: string;
}

export interface ObtainedKey {
  /** The public key, ready to put in `API_KEY_ENV_VAR`. */
  key: string;
  /**
   * The document the key was read from, so callers can cite it: the source URL, or
   * where its redirects led (userinfo shown as `***@`).
   */
  sourceUrl: string;
}

/**
 * Fetch the public key from its upstream source.
 *
 * Throws (rather than returning a placeholder) when the source is unreachable, no
 * longer states a key, states one that is not shaped like the published key
 * (`looksLikeApiKey`: a placeholder, trailing punctuation, a terminal escape), or
 * states two different ones — so a caller never proceeds with a made-up value.
 */
export async function obtainKey(options: ObtainKeyOptions = {}): Promise<ObtainedKey> {
  // A JavaScript caller may pass null for "no options"; anything else must be an object.
  options = options ?? {};
  if (!isPlainObject(options)) {
    throw new AusbildungValidationError("Invalid options: Expected an object of obtainKey options.");
  }
  const { sourceUrl: rawSourceUrl = KEY_SOURCE_URL, transport, timeoutMs, userAgent, maxRetries } = options;
  const { retryDelayMs, maxRedirects, maxResponseBytes, sleep } = options;
  assertValid("sourceUrl", rawSourceUrl, httpUrlProblem);
  // A source behind Basic auth (a private mirror) is named without its userinfo, in
  // the errors and in the result, and its credentials are cut from transport text.
  const sourceUrl = redactUrl(rawSourceUrl);
  const sourceCredentials = credentialsIn(rawSourceUrl);
  // Only the request policy is passed on: a caller's baseUrl or defaultHeaders (an
  // API key) have no business on the key source's host. The constructor
  // range-checks the options; inside this async function a bad one rejects.
  const engine = new RequestEngine({
    transport,
    timeoutMs,
    userAgent,
    maxRetries,
    retryDelayMs,
    maxRedirects,
    maxResponseBytes,
    sleep,
  });

  let response;
  try {
    response = await engine.getAbsolute(rawSourceUrl, "text/plain, text/markdown;q=0.9, */*;q=0.8");
  } catch (err) {
    if (err instanceof AusbildungNetworkError && sourceCredentials.length > 0) {
      // The engine scrubs only its base URL's credentials; this source has its own.
      throw new AusbildungNetworkError(redactCredentials(err.message, sourceCredentials));
    }
    if (!(err instanceof AusbildungApiError)) throw err;
    throw new AusbildungError(
      `Could not read the key source ${sourceUrl} (HTTP ${err.status}). ` +
        `Retry, or copy the key from github.com/bundesAPI/ausbildungssuche-api by hand.`,
      { cause: err },
    );
  }

  // Name the document the key was really read from: a redirect (followed by the
  // engine) may have led elsewhere, and the provenance note must not claim the
  // configured source for a key another host served.
  const readFrom = response.url === withoutUserinfo(rawSourceUrl) ? sourceUrl : redactUrl(response.url);
  const text = decodeBody(response.data, response.contentType, readFrom);
  const found = [...text.matchAll(KEY_PATTERN)].map((m) => (m[1] ?? "").trim());
  if (found.length === 0) {
    throw new AusbildungParseError(
      `No X-API-Key found at ${readFrom}. The upstream document may have changed ` +
        `format or stopped publishing the key — check it by hand before relying on this command.`,
    );
  }
  // Only a value of the published key's shape counts; the value itself is never
  // repeated in the message (it may hold a terminal escape).
  const keys = [...new Set(found)];
  if (keys.some((k) => !looksLikeApiKey(k))) {
    throw new AusbildungParseError(
      `The X-API-Key stated at ${readFrom} is not shaped like the published key ` +
        `(8–64 letters and digits joined by "-", "_" or "."; not a placeholder). ` +
        `The upstream document may have changed — check it by hand before relying on this command.`,
    );
  }
  if (keys.length > 1) {
    throw new AusbildungParseError(
      `${readFrom} states ${keys.length} different X-API-Key values, so which one is current ` +
        `can't be told — check the document by hand before relying on this command.`,
    );
  }
  return { key: keys[0] as string, sourceUrl: readFrom };
}

/** `url` without userinfo, as the engine reports a final URL, for comparing the two. */
function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(... obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
