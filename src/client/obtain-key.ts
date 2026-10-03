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

import { AusbildungApiError, AusbildungError, AusbildungParseError } from "./errors.js";
import { RequestEngine, type EngineOptions } from "./engine.js";
import { assertValid, httpUrlProblem } from "./validate.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "AUSBILDUNGSSUCHE_API_KEY";

/** Authoritative, plain-text source of the public key. */
export const KEY_SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/ausbildungssuche-api/main/README.md";

/** `X-API-Key: <value>` as documented in the source's curl examples. */
const KEY_PATTERN = /X-API-Key:\s*([^\s"'`]+)/i;

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
  /** Where it was read from, so callers can cite it. */
  sourceUrl: string;
}

/**
 * Fetch the public key from its upstream source.
 *
 * Throws (rather than returning a placeholder) when the source is unreachable or
 * no longer states a key, so a caller never proceeds with a made-up value.
 */
export async function obtainKey(options: ObtainKeyOptions = {}): Promise<ObtainedKey> {
  const { sourceUrl = KEY_SOURCE_URL, transport, timeoutMs, userAgent, maxRetries } = options;
  const { retryDelayMs, maxRedirects, maxResponseBytes, sleep } = options;
  assertValid("sourceUrl", sourceUrl, httpUrlProblem);
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
    response = await engine.getAbsolute(sourceUrl, "text/plain, text/markdown;q=0.9, */*;q=0.8");
  } catch (err) {
    if (!(err instanceof AusbildungApiError)) throw err;
    throw new AusbildungError(
      `Could not read the key source ${sourceUrl} (HTTP ${err.status}). ` +
        `Retry, or copy the key from github.com/bundesAPI/ausbildungssuche-api by hand.`,
      { cause: err },
    );
  }

  const text = response.data.toString("utf8");
  const key = KEY_PATTERN.exec(text)?.[1]?.trim();
  if (!key) {
    throw new AusbildungParseError(
      `No X-API-Key found at ${sourceUrl}. The upstream document may have changed ` +
        `format or stopped publishing the key — check it by hand before relying on this command.`,
    );
  }
  return { key, sourceUrl };
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(... obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
