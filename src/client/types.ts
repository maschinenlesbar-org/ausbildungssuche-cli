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
  /** "sw" — search keyword. */
  sw?: string;
  /** Offer type (0..4). */
  sty?: number;
  /** Profession id(s). */
  ids?: string;
  /** Location id. */
  orte?: string;
  /** Region / state code. */
  re?: string;
  /** Radius: "Bundesweit" or 25..200 (km). */
  uk?: string;
  /** Training type. */
  bart?: string;
  /** Education-voucher filter. */
  bg?: boolean;
  /** Start date. */
  bt?: string;
  /** 0-based page. */
  page?: number;
  /** Page size (1..2000; the CLI enforces this range). */
  size?: number;
}
