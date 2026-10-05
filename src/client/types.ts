// Domain types for the Bundesagentur für Arbeit Ausbildungssuche API
// (rest.arbeitsagentur.de/infosysbub/absuche).
//
// The API returns HAL+JSON (`_embedded` / `_links` / `page`); the embedded offer
// objects are large and nested, so they are exposed as faithful raw `JsonObject`s.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** HAL paging metadata. */
export interface PageInfo {
  size?: number;
  totalElements?: number;
  totalPages?: number;
  number?: number;
}

/** Response of the apprenticeship-offer search (HAL+JSON envelope). */
export interface AusbildungSearchResult {
  _embedded?: JsonObject;
  _links?: JsonObject;
  page?: PageInfo;
}

/** One apprenticeship offer record — kept as a faithful raw object (it has an `id`). */
export type AusbildungOffer = JsonObject;

/**
 * The answer of `details(id)`: a JSON array of offer records — one for one id — not
 * the search envelope. Read element `[0]`.
 */
export type AusbildungDetails = AusbildungOffer[];

/** Parameters for the apprenticeship-offer search. */
export interface AusbildungSearchParams {
  /** "sw" — search keyword. Currently ignored by the API; filter by occupation with `ids`. */
  sw?: string;
  /** Offer type, an integer 0..3 (`STY_MIN`..`STY_MAX`; the API rejects 4 with HTTP 400). */
  sty?: number;
  /** Occupation id(s): the `dkzId` from `angebot.systematiken[]`, comma-separated for several. */
  ids?: string;
  /**
   * Location as `Name_lon_lat` (longitude first, -180..180; latitude -90..90), e.g.
   * `Köln_6.957_50.938` (checked by `placeProblem`). Only restricts the search
   * together with a radius `uk`, so it is rejected without one (`placeAndRadiusProblem`).
   */
  orte?: string;
  /**
   * Bundesland code from `REGION_CODES` (`BAW`, `BAY`, … `THÜ`), comma-separated for several.
   * Each code is trimmed, NFC-normalised and uppercased before it is sent (`normalizeRegions`).
   */
  re?: string;
  /**
   * Radius from `RADII`: "Bundesweit" (in any case, `normalizeRadius`) or 10, 25, 50, 100 (km);
   * other values get HTTP 400. A km
   * radius is ignored by the API without a place `orte`, so it is rejected without one.
   */
  uk?: string;
  /** Training type. */
  bart?: string;
  /** Education-voucher filter. */
  bg?: boolean;
  /**
   * Start-date code(s), not a date: `2` = earlier dates, `101`..`112` = January..December
   * of the following year (upstream OpenAPI); `0` and `1` are accepted too. Comma-separated
   * for several (`START_CODES`).
   */
  bt?: string;
  /** 0-based page; `(page + 1) × size` must be at most `MAX_RESULT_WINDOW` (10000). */
  page?: number;
  /** Page size, 1..`MAX_PAGE_SIZE` (20): the server clamps anything above 20 to 20. */
  size?: number;
}
