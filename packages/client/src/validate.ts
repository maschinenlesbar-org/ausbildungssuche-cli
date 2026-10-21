// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives here (or next to the type it checks) as a pure
// `…Problem(value)` function: it returns the reason a value is invalid, or
// undefined when the value is fine. The client enforces a rule with assertValid
// before any request; the CLI's commander value-parsers call the same function and
// turn the reason into a usage error, so the rule exists exactly once.

import { AusbildungValidationError, quoteValue } from "./errors.js";
import type { AusbildungSearchParams } from "./types.js";

/** Why `value` is invalid, or `undefined` if it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Throw an AusbildungValidationError (`Invalid <name>: <reason>`) when `problem`
 * finds something wrong with `value`; otherwise return `value` unchanged.
 *
 * Client methods that return a promise call this inside an `async` body, so a
 * rejected input surfaces as a rejected promise rather than a synchronous throw,
 * and no request is sent.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new AusbildungValidationError(`Invalid ${name}: ${reason}`);
  }
  return value;
}

/**
 * An integer in min..max (a safe integer; NaN, Infinity and fractions are
 * invalid). With min 0 and max Number.MAX_SAFE_INTEGER the reason reads "Expected a
 * non-negative integer.".
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  const reason =
    min === 0 && max === Number.MAX_SAFE_INTEGER
      ? "Expected a non-negative integer."
      : `Expected an integer between ${min} and ${max}.`;
  return (n) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max ? undefined : reason;
}

/**
 * True for a plain object (`{}` or `Object.create(null)`): not null, an array, a
 * string, a Map or a class instance. Options and parameter bags must be one: `{...5}`
 * is `{}` (an unfiltered search) and `{..."x"}` is `{0: "x"}`.
 */
export function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it is empty or holds only whitespace,
 * control and format characters (a zero-width space, a soft hyphen) and combining marks. Such a
 * value reads as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter (the search term `sw`, an `orte` place name),
 * or undefined when it can. Refused, before any request, as the API would match nothing or
 * everything:
 * - a value that is blank (`isBlank`: empty, or only whitespace, invisible characters and
 *   combining marks): an empty filter reads as "no filter" upstream;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code or
 * an enum value (the offer id, an occupation id, `bart`, `uk`, a `re` or `bt` code): a value the
 * API compares exactly. The rules apply to the value with surrounding whitespace trimmed, as it
 * is sent (normalizeToken): not blank (and not only invisible characters or combining marks),
 * no lone surrogate, and no control or format character at all (a zero-width space, ZWJ, a soft
 * hyphen, a bidi control), since an invisible character in an id or a code only ever makes it
 * match nothing. The reason quotes the value visibly. Each token's own rule (digits, a listed
 * code) is checked after this one.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list value (`ids`, `re`, `bt`), as written: each item is
 * checked (`listProblem`) and canonicalised on its own, so `"9162, 9106"` sends `9106`, and
 * `"9162,,9106"`, `"9162,"` and `","` are refused rather than sent with an empty item (which
 * the API answers with HTTP 400, or reads as "no filter").
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item (`item 2 of 3: …`).
 */
export function listProblem(items: readonly string[], itemProblem: Problem = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/**
 * A free-text value as the API should get it: without surrounding whitespace (U+00A0
 * and U+3000 included; a value pasted with a trailing space or newline) and in composed
 * Unicode, NFC (a decomposed "Müller", u plus U+0308 as pasted from a macOS file name).
 * Inner whitespace is kept. Applied to the search term `sw` and to each place name of
 * `orte` (normalizePlaces); never to ids or codes.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * A blank value ("", whitespace, or only invisible characters and combining marks:
 * isBlank) is invalid: the API treats an empty parameter as no filter at all, so a
 * blank filter would silently return the unfiltered set.
 */
export const nonEmptyProblem: Problem = (value) =>
  isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * A value that can be sent in an HTTP header (User-Agent, X-API-Key, any
 * defaultHeaders value): non-blank, no C0 control character other than tab, no
 * DEL, nothing above U+00FF. Node's HTTP layer would otherwise throw an opaque
 * "Invalid character in header content" at request time, and a custom transport
 * would receive a CR/LF that injects a header. Checked by char code so the source
 * stays free of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  const blank = nonEmptyProblem(value);
  if (blank !== undefined) return blank;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * The API key (`apiKey`, `--api-key`, AUSBILDUNGSSUCHE_API_KEY): the key is sent
 * trimmed, so the trimmed value must be a valid header value (headerValueProblem).
 * Surrounding whitespace, a trailing newline from `$(cat key-file)` included, is
 * fine; a blank key or an inner control character is not. (The client treats a
 * blank `apiKey` as "no key" before this check; only the CLI's flag rejects one.)
 */
export const apiKeyProblem: Problem = (key) =>
  typeof key === "string" ? headerValueProblem(key.trim()) : "Expected a string.";

/**
 * A base URL (`baseUrl`, `--base-url`): an absolute http(s) URL, checked on the RAW
 * value. new URL() silently trims surrounding whitespace and drops tab/CR/LF, but
 * the engine appends request paths to the raw string, so a padded value would
 * request `/%20/...` or reach a custom transport unparsed. A query or fragment
 * would swallow every request path (`http://h/#f` requests `/` for every call).
 * A `%` in the user name or password must start a valid escape (`%25` for a literal
 * one): the userinfo is decoded for the Authorization header. Userinfo is allowed
 * (it is redacted from every message). The reasons never echo the value, so a
 * credential in it cannot leak.
 */
export const baseUrlProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected an absolute http(s) URL.";
  const blank = nonEmptyProblem(value);
  if (blank !== undefined) return blank;
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return "A base URL cannot contain whitespace or control characters.";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo for the Authorization header and throws "URI malformed"
  // for a "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * An absolute http(s) URL fetched as it is (obtainKey's `sourceUrl`), unlike a
 * base URL it may carry a query. The reason never echoes the value.
 */
export const httpUrlProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected an absolute http(s) URL.";
  const blank = nonEmptyProblem(value);
  if (blank !== undefined) return blank;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  return url.protocol === "http:" || url.protocol === "https:"
    ? undefined
    : `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
};

/** An HTTP header name: an RFC 9110 token. */
export const headerNameProblem: Problem = (name) =>
  typeof name === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+-.^_`|~).";

/**
 * True for a positive whole number written in digits only, leading zeros allowed, of
 * at most 18 significant digits. The API reads ids as 64-bit integers: `0` and a
 * value past that range (a 23-digit id) get a bare HTTP 400.
 */
function isIdNumber(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const significant = value.replace(/^0+/, "");
  return significant.length >= 1 && significant.length <= 18;
}

/**
 * An offer id (`details`) is a token (tokenProblem; sent trimmed) of digits only, at
 * least 1 (`00401584387` names offer 401584387). Anything else cannot name an offer: put
 * into the path, it could re-target the request (`..`, `12/34`, `?x`) with the API key
 * attached, and `0` or a 23-digit id gets a bare HTTP 400.
 */
export const offerIdProblem: Problem = (id) => {
  const numeric = "Expected a numeric offer id (digits only, at least 1, at most 18 digits).";
  // A JS caller may pass a non-string; reject it as invalid rather than throw a TypeError.
  if (typeof id !== "string") return numeric;
  // Sent trimmed (normalizeToken), like every token.
  return tokenProblem(id) ?? (isIdNumber(id.trim()) ? undefined : numeric);
};

/**
 * The occupation ids (`ids`): one or more `dkzId`s, comma-separated, each a token
 * (tokenProblem) of digits (at least 1). The API answers a non-numeric id, and an empty
 * item from a trailing comma (`9162,` — the classic output of a script that joins ids),
 * with a bare HTTP 400. Space around an item is fine (normalizeIds trims it).
 */
export const idsProblem: Problem = (ids) => {
  const blank = nonEmptyProblem(ids);
  if (blank !== undefined) return blank;
  const items = splitList(ids);
  if (items.some(isBlank)) {
    return "Expected occupation ids (dkzId) separated by single commas, without an empty item (a trailing comma).";
  }
  return listProblem(items, occupationIdProblem);
};

/** One occupation id of `ids`: a token of digits. A value that is no plain word is not repeated. */
const occupationIdProblem: Problem = (item) => {
  const token = tokenProblem(item);
  if (token !== undefined) return token;
  const id = item.trim();
  return isIdNumber(id)
    ? undefined
    : `Expected numeric occupation ids (dkzId, digits only), e.g. 9162 or 9162,9106; "${/^[\w.-]{1,20}$/.test(id) ? id : "(not shown)"}" is not one.`;
};

/** The occupation ids (`ids`) as sent: each comma-separated item trimmed and in NFC (normalizeToken). Idempotent. */
export function normalizeIds(ids: string): string {
  return splitList(ids).map(normalizeToken).join(",");
}

/**
 * The training type (`bart`, Bildungsart): one numeric `bildungsart.id`, e.g. `102`
 * Berufsausbildung. The API answers a non-numeric value (`abc`, `Berufsausbildung`,
 * `10x`) with a bare HTTP 400; an unknown number gives an empty result.
 */
export const trainingTypeProblem: Problem = (bart) =>
  tokenProblem(bart) ??
  (isIdNumber(bart.trim()) ? undefined : "Expected a numeric training type (bildungsart.id), e.g. 102 Berufsausbildung.");

/** Smallest and largest offer type (`sty`); the API answers `4` with HTTP 400. */
export const STY_MIN = 0;
export const STY_MAX = 3;

/** The offer type (`sty`): an integer in STY_MIN..STY_MAX. */
export const styProblem: Problem<number> = intRangeProblem(STY_MIN, STY_MAX);

/** The radii (`uk`) the API accepts; anything else gets HTTP 400. */
export const RADII = ["10", "25", "50", "100", "Bundesweit"] as const;

/** The radius (`uk`): a token (tokenProblem) that is one of RADII once normalised (normalizeRadius). */
export const radiusProblem: Problem = (uk) =>
  tokenProblem(uk) ??
  ((RADII as readonly string[]).includes(normalizeRadius(uk)) ? undefined : "Expected 10, 25, 50, 100 (km) or Bundesweit.");

/**
 * The radius (`uk`) in the form the API accepts: trimmed and in NFC (normalizeToken), and
 * `bundesweit` in any case becomes `Bundesweit` (the API answers the lowercase form with
 * HTTP 400). Any other value is returned so for radiusProblem to judge. Idempotent.
 */
export function normalizeRadius(uk: string): string {
  const token = normalizeToken(uk);
  return token.toLowerCase() === "bundesweit" ? "Bundesweit" : token;
}

/** The 3-letter Bundesland codes (`re`) the API accepts, in the uppercase it requires. */
export const REGION_CODES = [
  "BAW", "BAY", "BER", "BRA", "BRE", "HAM", "HES", "MBV",
  "NDS", "NRW", "RPF", "SAA", "SAC", "SAN", "SLH", "THÜ",
] as const;

/** One Bundesland code: a member of REGION_CODES, exactly as listed. */
export const regionCodeProblem: Problem = (code) =>
  (REGION_CODES as readonly string[]).includes(code)
    ? undefined
    : `Unknown Bundesland code ${quoteValue(code)}. Expected one or more of ${REGION_CODES.join(", ")}, comma-separated.`;

/**
 * One Bundesland code in the form the API accepts: trimmed, NFC-normalised (an NFD
 * `THÜ` becomes the listed `THÜ`) and uppercased (the API answers `nrw` with HTTP
 * 400). Idempotent.
 */
export function normalizeRegionCode(code: string): string {
  return code.trim().normalize("NFC").toUpperCase();
}

/** The region filter (`re`), each comma-separated code normalised (normalizeRegionCode). Idempotent. */
export function normalizeRegions(re: string): string {
  return splitList(re).map(normalizeRegionCode).join(",");
}

/**
 * The region filter (`re`): one or more comma-separated codes, each a token (tokenProblem)
 * that is one of REGION_CODES once normalised (normalizeRegionCode: `" nrw"` is `NRW`). The
 * message names a code as written.
 */
export const regionsProblem: Problem = (re) =>
  nonEmptyProblem(re) ??
  listProblem(splitList(re), (code) =>
    tokenProblem(code) ?? (regionCodeProblem(normalizeRegionCode(code)) === undefined ? undefined : regionCodeProblem(code.trim())),
  );

/** The start-date codes (`bt`) the API accepts: 0, 1, 2 and 101..112. */
export const START_CODES = ["0", "1", "2", ...Array.from({ length: 12 }, (_, i) => String(101 + i))] as const;

/**
 * The start-date filter (`bt`): one or more comma-separated codes, each a token
 * (tokenProblem; sent trimmed) that is one of START_CODES.
 */
export const startCodesProblem: Problem = (bt) =>
  nonEmptyProblem(bt) ??
  listProblem(splitList(bt), (code) =>
    tokenProblem(code) ??
    ((START_CODES as readonly string[]).includes(code.trim()) ? undefined : "Expected start-date codes 0, 1, 2 or 101..112, comma-separated."),
  );

/** The start-date filter (`bt`) as sent: each code trimmed and in NFC (normalizeToken). Idempotent. */
export function normalizeStartCodes(bt: string): string {
  return splitList(bt).map(normalizeToken).join(",");
}

/**
 * The places of an `orte` value: split at each comma that follows a coordinate, with or
 * without whitespace between (`Köln_6.957_50.938,Berlin_13.405_52.52`,
 * `Köln_6.957_50.938 , Berlin_13.405_52.52`; the API splits both), so a comma inside a
 * place name stays part of that name. The places are returned as written (untrimmed).
 */
export function splitPlaces(orte: string): string[] {
  return orte.split(/(?<=_-?\d+(?:\.\d+)?\s*),/);
}

/**
 * The place filter (`orte`) with each place's name in canonical form (normalizeText):
 * `" Köln _6.957_50.938, Berlin_13.4_52.5"` → `Köln_6.957_50.938,Berlin_13.4_52.5`. A
 * place without the `_lon_lat` ending is only trimmed and composed, for placeProblem
 * to refuse. Idempotent.
 */
export function normalizePlaces(orte: string): string {
  return splitPlaces(orte.trim())
    .map((place) => {
      const m = /^([\s\S]*?)(_-?\d+(?:\.\d+)?_-?\d+(?:\.\d+)?)$/.exec(place.trim());
      return m ? `${normalizeText(m[1] ?? "")}${m[2] ?? ""}` : normalizeText(place);
    })
    .join(",");
}

/**
 * The place (`orte`): `Name_lon_lat` with the longitude in -180..180 first and the
 * latitude in -90..90 second — or several such places, comma-separated, which the
 * API searches together (live: Köln's 3 offers + Berlin's 17 = 20). Every place is
 * checked: the API answers a bare place name with HTTP 400 and out-of-range
 * coordinates with HTTP 500, also when only one of several places has them, and an
 * empty item (`A,,B`) with HTTP 400.
 */
export const placeProblem: Problem = (orte) => {
  const blank = nonEmptyProblem(orte);
  if (blank !== undefined) return blank;
  const places = splitPlaces(orte);
  // A place that starts with a comma is an empty item (`A,,B`, `,A`): its name would be
  // read as `,B`, and the API answers HTTP 400.
  if (places.some((place) => place.trim().startsWith(","))) {
    return 'Expected places separated by single commas, without an empty item (",," or a comma at the start).';
  }
  // Each name is a text filter (textProblem): an invisible or control character is refused
  // and shown escaped.
  for (const place of places) {
    const m = /^([\s\S]*?)_-?\d+(?:\.\d+)?_-?\d+(?:\.\d+)?$/.exec(place.trim());
    const name = m === null || m[1] === "" ? undefined : textProblem(m[1] ?? "");
    if (name !== undefined) return places.length > 1 ? `the name of a place: ${name}` : name;
  }
  const ok = places.every((place) => {
    const m = /^(.*\S.*)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(place.trim());
    const lon = m ? Number(m[2]) : NaN;
    const lat = m ? Number(m[3]) : NaN;
    return Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
  });
  if (ok) return undefined;
  return (
    'Expected "Name_lon_lat" with the longitude (-180..180) first and the latitude ' +
    '(-90..90) second, e.g. "Köln_6.957_50.938"' +
    (places.length > 1 ? ", for every one of the comma-separated places." : ".")
  );
};

/**
 * A short description of a JSON value for a message: its kind, and for an object its
 * first keys. A key is server text, so only a plain one (letters, digits, `_ . -`, at
 * most 40 characters) is shown as it is.
 */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
  if (typeof value === "object") {
    const keys = Object.keys(value as object)
      .slice(0, 5)
      .map((k) => (/^[\w.-]{1,40}$/.test(k) ? `"${k}"` : "(a key not shown)"));
    return `an object with ${keys.join(", ") || "no keys"}`;
  }
  return `a ${typeof value}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why a 2xx body is not a search result, or `undefined` when it is: the HAL envelope,
 * an object with a `page` object whose `totalElements` is a non-negative integer and,
 * when there are hits, `_embedded.termine`, an array of objects (a search without hits
 * has no `_embedded` at all). A proxy, captive portal or mirror answering `null`, a
 * string, `[]`, `{}` or an error object (`{"error": "rate limited"}`) with HTTP 200
 * must not be printed as an empty result with exit 0: a script would read it as
 * "0 offers".
 */
export const searchResultProblem: Problem<unknown> = (value) => {
  const expected = `expected a search result (page, _embedded.termine), got ${kindOf(value)}`;
  if (!isObject(value)) return expected;
  const page = value["page"];
  if (!isObject(page)) return expected;
  const total = page["totalElements"];
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    return "expected a search result whose page.totalElements is a non-negative integer";
  }
  const embedded = value["_embedded"];
  if (embedded === undefined) return undefined;
  if (!isObject(embedded)) return "expected a search result whose _embedded is an object";
  const termine = embedded["termine"];
  if (termine !== undefined && (!Array.isArray(termine) || termine.some((t) => !isObject(t)))) {
    return "expected a search result whose _embedded.termine is an array of offers (objects)";
  }
  return undefined;
};

/**
 * Why a 2xx body is not an offer's details, or `undefined` when it is: the detail
 * endpoint answers a JSON array of offer records (one, for one id), each an object
 * with an `id`. An empty array, `{}`, `null` or an error object is not an answer
 * (an unknown id is a 404).
 */
export const detailsProblem: Problem<unknown> = (value) => {
  const expected = `expected an array of offers (objects with an id), got ${kindOf(value)}`;
  if (!Array.isArray(value) || value.length === 0) return expected;
  for (const offer of value) {
    const id = isObject(offer) ? offer["id"] : undefined;
    if ((typeof id !== "number" && typeof id !== "string") || String(id).trim() === "") return expected;
  }
  return undefined;
};

/**
 * Largest page size (`size`) the API honours. Its OpenAPI description says 2000,
 * but the server clamps every larger `size` to 20 (it reports `page.size` 20), so
 * `page` would count in pages of 20 while a caller computes offsets from its own
 * size. `size=0` is silently overridden to 20 as well.
 */
export const MAX_PAGE_SIZE = 20;

/** Page size the API uses when `size` is not given. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * The API serves at most this many results of one query, over all pages; a page
 * beyond it (`(page + 1) * size > 10000`) gets HTTP 500.
 */
export const MAX_RESULT_WINDOW = 10_000;

/** The 0-based page (`page`): a non-negative integer. */
export const pageProblem: Problem<number> = intRangeProblem(0, Number.MAX_SAFE_INTEGER);

/** The page size (`size`): an integer in 1..MAX_PAGE_SIZE. */
export const sizeProblem: Problem<number> = intRangeProblem(1, MAX_PAGE_SIZE);

/**
 * The result window: `(page + 1) × size` (size defaulting to DEFAULT_PAGE_SIZE)
 * must be at most MAX_RESULT_WINDOW, or the API answers with a bare HTTP 500. The
 * reason names the last page that can be fetched.
 */
export const resultWindowProblem: Problem<Pick<AusbildungSearchParams, "page" | "size">> = ({
  page,
  size,
}) => {
  if (page === undefined) return undefined;
  const pageSize = size ?? DEFAULT_PAGE_SIZE;
  if ((page + 1) * pageSize <= MAX_RESULT_WINDOW) return undefined;
  return (
    `${page} is past the API's ${MAX_RESULT_WINDOW}-result window: ` +
    `(page + 1) × size must be at most ${MAX_RESULT_WINDOW}, so with size ${pageSize} ` +
    `the last page is ${Math.floor(MAX_RESULT_WINDOW / pageSize) - 1}.`
  );
};

/**
 * `orte` and a km radius `uk` only filter together: the API ignores a numeric
 * radius without a place, and a place without a radius does not restrict the
 * search at all (it only adds distances). Either alone would silently return the
 * nationwide set. `uk: "Bundesweit"` alone is fine: it asks for exactly what the
 * API returns without a place.
 *
 * `label` names a parameter in the reason; the CLI passes `(p) => "--" + p` so the
 * reason names its flags.
 */
export function placeAndRadiusProblem(
  params: Pick<AusbildungSearchParams, "orte" | "uk">,
  label: (param: "orte" | "uk") => string = (param) => param,
): string | undefined {
  const { orte, uk } = params;
  const [ORTE, UK] = [label("orte"), label("uk")];
  if (uk !== undefined && orte === undefined && String(uk).toLowerCase() !== "bundesweit") {
    return (
      `${UK} ${uk} needs ${ORTE}: a radius is measured around a place, and without one the ` +
      `API ignores it. Leave ${UK} out (or use ${UK} Bundesweit) for a nationwide search.`
    );
  }
  if (orte !== undefined && uk === undefined) {
    return (
      `${ORTE} needs ${UK}: without a radius the API does not restrict the search to the ` +
      `place. Add ${UK} 10, 25, 50 or 100 (km), or ${UK} Bundesweit to search nationwide ` +
      "with distances."
    );
  }
  return undefined;
}

/**
 * Search parameters in the form the API accepts: `sw` through normalizeText, `orte`
 * through normalizePlaces, `re` through normalizeRegions, `uk` through normalizeRadius,
 * `ids` through normalizeIds, `bt` through normalizeStartCodes and `bart` through
 * normalizeToken
 * (string values, also inside an array); everything else unchanged. Returns a new object. search() applies it before
 * validateSearchParams, so `re: " nrw"` and `uk: "bundesweit"` are sent as
 * `NRW` and `Bundesweit`, as the CLI sends them.
 */
export function normalizeSearchParams(params: AusbildungSearchParams): AusbildungSearchParams {
  // Checked before the copy: `{...5}` is `{}`, which would search unfiltered.
  if (!isPlainObject(params)) {
    throw new AusbildungValidationError("Invalid search parameters: Expected an object of search parameters.");
  }
  const out: AusbildungSearchParams = { ...params };
  if (params.sw !== undefined) out.sw = mapStrings(params.sw, normalizeText);
  if (params.orte !== undefined) out.orte = mapStrings(params.orte, normalizePlaces);
  if (params.re !== undefined) out.re = mapStrings(params.re, normalizeRegions);
  if (params.ids !== undefined) out.ids = mapStrings(params.ids, normalizeIds);
  if (params.bart !== undefined) out.bart = mapStrings(params.bart, normalizeToken);
  if (params.bt !== undefined) out.bt = mapStrings(params.bt, normalizeStartCodes);
  if (params.uk !== undefined) out.uk = mapStrings(params.uk, normalizeRadius);
  return out;
}

/** Apply `fn` to a string, or to each string element of an array; leave anything else alone. */
function mapStrings(value: string, fn: (s: string) => string): string {
  const one = (v: unknown): unknown => (typeof v === "string" ? fn(v) : v);
  // A JS caller may pass an array; the query builder sends each element.
  return (Array.isArray(value) ? (value as unknown[]).map(one) : one(value)) as string;
}

/**
 * Check search parameters before any request, and throw an
 * AusbildungValidationError naming the first parameter that breaks a rule:
 *
 * - `params` must be a plain object, every key one of SEARCH_PARAMS
 *   (searchParamKeyProblem; `options.allowUnknownFilters` lifts that one rule) and
 *   every value a single value of its type, not an array;
 * - every string parameter (`sw`, `ids`, `orte`, `re`, `uk`, `bart`, `bt`) must be
 *   non-blank (nonEmptyProblem);
 * - `sty`, `re`, `uk` and `bt` must come from the API's closed value sets
 *   (styProblem, regionsProblem, radiusProblem, startCodesProblem), `ids` numeric
 *   comma-separated ids (idsProblem), `bart` one numeric training type
 *   (trainingTypeProblem), and `orte` must be `Name_lon_lat` (placeProblem);
 * - `orte` and a km radius `uk` must be given together (placeAndRadiusProblem);
 * - `page` must be a non-negative integer, `size` an integer in 1..MAX_PAGE_SIZE,
 *   and the page must lie inside the MAX_RESULT_WINDOW (pageProblem, sizeProblem,
 *   resultWindowProblem).
 *
 * `undefined` means "not set" and is never checked.
 */
export function validateSearchParams(
  params: AusbildungSearchParams,
  options: { allowUnknownFilters?: boolean | undefined } = {},
): AusbildungSearchParams {
  if (!isPlainObject(params)) {
    throw new AusbildungValidationError("Invalid search parameters: Expected an object of search parameters.");
  }
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (options.allowUnknownFilters !== true) assertValid("search parameter", name, searchParamKeyProblem);
    // Every parameter takes one value (a list is one comma-separated string): an array
    // would go out as repeated keys, which the API does not combine.
    if (Array.isArray(value)) {
      throw new AusbildungValidationError(
        `Invalid ${name}: Expected one value, got an array; give several ids, codes or places comma-separated in one string.`,
      );
    }
  }
  for (const [name, value] of Object.entries(params)) {
    for (const item of listOf(value)) {
      const reason = paramTypeProblem(name, item);
      if (reason !== undefined) throw new AusbildungValidationError(`Invalid ${name}: ${reason}`);
    }
  }
  for (const [name, value] of Object.entries(params)) {
    for (const item of listOf(value)) {
      if (typeof item === "string") assertValid(name, item, nonEmptyProblem);
    }
  }
  if (params.sty !== undefined) assertValid("sty", params.sty, styProblem);
  const textRules: Array<[keyof AusbildungSearchParams, Problem]> = [
    ["sw", textProblem],
    ["ids", idsProblem],
    ["bart", trainingTypeProblem],
    ["orte", placeProblem],
    ["re", regionsProblem],
    ["uk", radiusProblem],
    ["bt", startCodesProblem],
  ];
  for (const [name, problem] of textRules) {
    // A JS caller may pass a number (`uk: 25`) or an array; each value is checked
    // in the form the query builder sends it.
    for (const item of listOf(params[name])) assertValid(name, String(item), problem);
  }
  if (params.page !== undefined) assertValid("page", params.page, pageProblem);
  if (params.size !== undefined) assertValid("size", params.size, sizeProblem);
  assertValid("orte and uk", params, (p) => placeAndRadiusProblem(p));
  assertValid("page", params, resultWindowProblem);
  return params;
}

/**
 * The parameters the search endpoint takes. The API ignores any other key and answers
 * with the whole unfiltered set, so `search()` rejects one (searchParamKeyProblem),
 * unless the caller opts out with `{ allowUnknownFilters: true }`.
 */
export const SEARCH_PARAMS = ["sw", "sty", "ids", "orte", "re", "uk", "bart", "bg", "bt", "page", "size"] as const;

/**
 * Why `key` is not a search parameter, or `undefined`. A misspelled (`idss`),
 * wrong-case (`IDS`), unknown (`bundesland`) or `__proto__` key would be sent and
 * ignored, returning the nationwide set with exit 0.
 */
export const searchParamKeyProblem: Problem = (key) =>
  (SEARCH_PARAMS as readonly string[]).includes(key)
    ? undefined
    : `Unknown search parameter "${/^[\w.-]{1,40}$/.test(key) ? key : "(not shown)"}". Expected one of ${SEARCH_PARAMS.join(", ")} ` +
      "(the API ignores any other and would return the unfiltered set).";

/** The search parameters whose value is text (a JavaScript caller may pass a number). */
const TEXT_PARAMS = new Set(["sw", "ids", "orte", "re", "uk", "bart", "bt"]);
/** The search parameters whose value is an integer (checked by their own range rule). */
const INT_PARAMS = new Set(["sty", "page", "size"]);

/**
 * Why one value of search parameter `name` has the wrong type, or `undefined`. Text
 * parameters take a string or a finite number (`uk: 25`), the integer ones a number
 * (their range rules say which), `bg` a boolean. Anything else — an object, a Date,
 * NaN, a function — was sent as "[object Object]", an ISO date or "NaN".
 */
function paramTypeProblem(name: string, value: unknown): string | undefined {
  if (TEXT_PARAMS.has(name)) {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
      ? undefined
      : `Expected a string, got ${describeType(value)}.`;
  }
  if (INT_PARAMS.has(name)) {
    return typeof value === "number" ? undefined : `Expected an integer, got ${describeType(value)}.`;
  }
  if (name === "bg") return typeof value === "boolean" ? undefined : `Expected true or false, got ${describeType(value)}.`;
  return undefined;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "a Date";
  return typeof value === "number" && Number.isNaN(value) ? "NaN" : `a ${typeof value}`;
}

/** The values a query parameter sends: none for undefined/null, each element of an array. */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null) : [value];
}
