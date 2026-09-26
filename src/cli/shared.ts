// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { AusbildungssucheClientOptions } from "../client/client.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals (`0x10`, `0b10`, `1e3`), signs, padding and decimals (`+5`, `5.0`).
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * commander value-parser: a value that is not blank. A blank filter would
 * otherwise be dropped and the command would silently run unfiltered.
 */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for `--base-url`: an absolute http(s) URL. A `file:`,
 * `ftp:` or malformed value is a usage error at parse time rather than reaching
 * the client (an injected custom transport does no scheme check of its own).
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(
      `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`,
    );
  }
  return value;
}

/**
 * Wrap a commander value-parser for a single-valued option so that a second
 * occurrence is a usage error. commander otherwise keeps only the last value, so
 * `--uk 10 --uk 50` silently dropped the first. (The option must have no default:
 * commander passes the default as `previous` on the first occurrence.)
 */
export function once<T>(parse: (value: string) => T): (value: string, previous: T | undefined) => T {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError("Given more than once; this option takes a single value.");
    }
    return parse(value);
  };
}

/**
 * Wrap a commander value-parser for an option whose API parameter takes a
 * comma-separated list (`--ids`, `--re`, `--bt`): repeats accumulate, joined with
 * ",", so `--ids 9162 --ids 9106` sends `ids=9162,9106` like `--ids 9162,9106`
 * instead of keeping only the last value.
 */
export function commaList(
  parse: (value: string) => string,
): (value: string, previous: string | undefined) => string {
  return (value, previous) => {
    const parsed = parse(value);
    return previous === undefined ? parsed : `${previous},${parsed}`;
  };
}

/** Build a commander value-parser for a base-10 integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`Expected an integer between ${min} and ${max}.`);
    }
    return n;
  };
}

/**
 * Largest page size the API honours. Its OpenAPI description says 2000, but the
 * server clamps every larger `size` to 20 (it reports `page.size` 20), so `--page`
 * would count in pages of 20 while a script computes offsets from its own size.
 */
export const MAX_PAGE_SIZE = 20;

/**
 * commander value-parser for `--size`: a base-10 integer in 1..MAX_PAGE_SIZE.
 * `size=0` is nonsensical (the server silently overrides it to 20) and a larger
 * size is silently clamped to 20 server-side, so both are rejected up front
 * rather than sent and quietly changed.
 */
export function parseSizeArg(value: string): number {
  const n = parseIntArg(value);
  if (n < 1 || n > MAX_PAGE_SIZE) {
    throw new InvalidArgumentError(`Expected an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return n;
}

/** The radii (`uk`) the API accepts; anything else gets HTTP 400. */
export const RADII = ["10", "25", "50", "100", "Bundesweit"] as const;

/**
 * commander value-parser for `--uk`: one of RADII. `bundesweit` in any case is
 * normalised to the `Bundesweit` the API expects (lowercase gets HTTP 400).
 */
export function parseRadius(value: string): string {
  parseNonEmpty(value);
  if (value.toLowerCase() === "bundesweit") return "Bundesweit";
  if (!(RADII as readonly string[]).includes(value)) {
    throw new InvalidArgumentError("Expected 10, 25, 50, 100 (km) or Bundesweit.");
  }
  return value;
}

/** The 3-letter Bundesland codes (`re`) the API accepts. */
export const REGION_CODES = [
  "BAW", "BAY", "BER", "BRA", "BRE", "HAM", "HES", "MBV",
  "NDS", "NRW", "RPF", "SAA", "SAC", "SAN", "SLH", "THÜ",
] as const;

/**
 * commander value-parser for `--re`: one or more comma-separated REGION_CODES, in
 * any case (the API wants uppercase and answers `nrw` with a bare HTTP 400), so
 * they are normalised to uppercase.
 */
export function parseRegions(value: string): string {
  parseNonEmpty(value);
  return value
    .split(",")
    .map((item) => {
      const code = item.trim().normalize("NFC").toUpperCase();
      if (!(REGION_CODES as readonly string[]).includes(code)) {
        throw new InvalidArgumentError(
          `Unknown Bundesland code "${item}". Expected one or more of ${REGION_CODES.join(", ")}, comma-separated.`,
        );
      }
      return code;
    })
    .join(",");
}

/**
 * commander value-parser for `--bt`: one or more comma-separated start-date codes,
 * 0, 1, 2 or 101..112 — the codes the API accepts; any other value gets HTTP 400.
 */
export function parseStartCodes(value: string): string {
  parseNonEmpty(value);
  for (const item of value.split(",")) {
    const n = /^(?:0|[1-9]\d{0,2})$/.test(item) ? Number(item) : NaN;
    if (!(n <= 2 || (n >= 101 && n <= 112))) {
      throw new InvalidArgumentError("Expected start-date codes 0, 1, 2 or 101..112, comma-separated.");
    }
  }
  return value;
}

/**
 * commander value-parser for `--orte`: `Name_lon_lat` with the longitude in
 * -180..180 first and the latitude in -90..90 second. The API answers a bare place
 * name with HTTP 400 and out-of-range coordinates with HTTP 500.
 */
export function parsePlace(value: string): string {
  parseNonEmpty(value);
  const m = /^(.*\S.*)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(value);
  const lon = m ? Number(m[2]) : NaN;
  const lat = m ? Number(m[3]) : NaN;
  if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) {
    throw new InvalidArgumentError(
      'Expected "Name_lon_lat" with the longitude (-180..180) first and the latitude ' +
        '(-90..90) second, e.g. "Köln_6.957_50.938".',
    );
  }
  return value;
}

/** commander value-parser for an offer id: the API's offer ids are numeric. */
export function parseOfferId(value: string): string {
  parseNonEmpty(value);
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a numeric offer id (digits only).");
  }
  return value;
}

/**
 * The API serves at most this many results of one query, over all pages; a page
 * beyond it (`(page + 1) * size > 10000`) gets HTTP 500.
 */
export const MAX_RESULT_WINDOW = 10_000;

/** Page size the API uses when `size` is not given. */
export const DEFAULT_PAGE_SIZE = 20;

export interface GlobalOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): AusbildungssucheClientOptions {
  const options: AusbildungssucheClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.apiKey !== undefined) options.apiKey = global.apiKey;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
