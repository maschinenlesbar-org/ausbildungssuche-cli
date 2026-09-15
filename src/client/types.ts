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
  /** Offer type (0..3; the API rejects 4 with HTTP 400). */
  sty?: number;
  /** Occupation id(s): the `dkzId` from `angebot.systematiken[]`, comma-separated for several. */
  ids?: string;
  /** Location as `Name_lon_lat` (longitude first), e.g. `Köln_6.957_50.938`. */
  orte?: string;
  /** Bundesland code (`BAW`, `BAY`, … `THÜ`), comma-separated for several. */
  re?: string;
  /** Radius: "Bundesweit" or 10, 25, 50, 100 (km); other values get HTTP 400. */
  uk?: string;
  /** Training type. */
  bart?: string;
  /** Education-voucher filter. */
  bg?: boolean;
  /** Start date. */
  bt?: string;
  /** 0-based page. */
  page?: number;
  /** Page size (1..2000; the CLI enforces this range). The server returns at most 20 rows. */
  size?: number;
}
