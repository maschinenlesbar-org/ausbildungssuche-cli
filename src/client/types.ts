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

/** A single apprenticeship offer — kept as a faithful raw object. */
export type AusbildungDetails = JsonObject;

/** Parameters for the apprenticeship-offer search. */
export interface AusbildungSearchParams {
  /** "sw" — search keyword. Currently ignored by the API; filter by occupation with `ids`. */
  sw?: string;
  /** Offer type (0..3; the API rejects 4 with HTTP 400, the CLI anything outside 0..3). */
  sty?: number;
  /** Occupation id(s): the `dkzId` from `angebot.systematiken[]`, comma-separated for several. */
  ids?: string;
  /**
   * Location as `Name_lon_lat` (longitude first), e.g. `Köln_6.957_50.938`. Only
   * restricts the search together with a radius `uk`; alone it just adds distances.
   */
  orte?: string;
  /** Bundesland code (`BAW`, `BAY`, … `THÜ`), comma-separated for several. */
  re?: string;
  /**
   * Radius: "Bundesweit" or 10, 25, 50, 100 (km); other values get HTTP 400. A km
   * radius is ignored by the API without a place `orte`.
   */
  uk?: string;
  /** Training type. */
  bart?: string;
  /** Education-voucher filter. */
  bg?: boolean;
  /**
   * Start-date code(s), not a date: `2` = earlier dates, `101`..`112` = January..December
   * of the following year (upstream OpenAPI); `0` and `1` are accepted too. Comma-separated
   * for several.
   */
  bt?: string;
  /** 0-based page. */
  page?: number;
  /** Page size. The server clamps anything above 20 to 20; the CLI accepts 1..20. */
  size?: number;
}
