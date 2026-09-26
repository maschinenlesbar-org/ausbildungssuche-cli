# Glossary

A reference for the domain concepts and project-specific terms used throughout
`ausbildungssuche-cli`. The domain is the German federal **apprenticeship /
vocational-training** catalogue; this glossary gives the English term used in the
CLI/library alongside the original German, and decodes the API's terse
abbreviated query parameters.

> **Search-parameter cheat sheet.** The upstream API names its query parameters
> with short German abbreviations. The CLI exposes them as flags of the same
> name, so they map one-to-one:
>
> | API param / flag | Meaning |
> | --- | --- |
> | `sw` | Suchwort — search keyword (currently ignored by the API) |
> | `sty` | Suchtyp — offer/search type (`0`..`3`) |
> | `orte` | Ort — location (`Name_lon_lat`) |
> | `re` | Region — Bundesland code |
> | `uk` | Umkreis — search radius (km, or `Bundesweit`) |
> | `ids` | Berufs-id(s) — occupation id(s) |
> | `bart` | Bildungsart — training/education type |
> | `bg` | Bildungsgutschein — education-voucher filter |
> | `bt` | Beginntermin — start-date code (`2`, `101`..`112`; not a date) |
> | `page` | 0-based page index |
> | `size` | page size (`1`..`2000`; the server returns at most 20) |

---

## The programme & API

**Ausbildungssuche.** "Apprenticeship search" — the Bundesagentur für Arbeit's
public catalogue of apprenticeship and vocational-training offers
(*Ausbildungsangebote*), searchable online at the agency's portal and exposed by
the REST API this tool wraps.

**Bundesagentur für Arbeit (BA).** The German Federal Employment Agency, which
operates the Ausbildungssuche service and its API.

**Ausbildungssuche API.** The REST service at
`rest.arbeitsagentur.de/infosysbub/absuche`. It is part of the agency's
`infosysbub` (Informationssystem Bildung und Beruf) family of services;
`absuche` is the Ausbildungssuche component. Documented at
[ausbildungssuche.api.bund.dev](https://ausbildungssuche.api.bund.dev/).

**X-API-Key.** A static, publicly-documented API key
required on every request. It is **not bundled** — obtain it with `obtain-key` or supply
it via `--api-key`, the `AUSBILDUNGSSUCHE_API_KEY` env var, or the `apiKey` client
option, else the header is omitted and the service answers `401`/`403`. An
empty/whitespace key is treated as absent (no header sent). For CI / live testing
the public key can be fetched out-of-band (never from the CLI) via
the CLI's own `obtain-key` command (`npm run obtain-key`).

---

## Resources / endpoints

**Ausbildungsangebot (apprenticeship offer).** The central resource — a single
apprenticeship/training offer. The API surfaces it through two endpoints:

**Search (`/pc/v1/ausbildungsangebot`).** The offer-search collection. Accepts
the search parameters above and returns a HAL+JSON envelope. Served as
`application/hal+json`; it answers `406` to a plain `application/json` `Accept`,
so the client requests HAL explicitly. CLI: `search`. Library: `client.search()`.

**Details (`/pc/v1/ausbildungsangebot/{id}`).** Full detail for one offer by id.
This endpoint serves `application/json` (and conversely answers `406` to a
HAL+JSON `Accept`), so the client requests plain JSON here. CLI: `details <id>`.
Library: `client.details(id)`.

---

## Search-result envelope (HAL+JSON)

**HAL+JSON.** Hypertext Application Language over JSON — the media type the search
endpoint returns. A HAL document carries the payload plus hypermedia metadata in
reserved `_embedded` and `_links` members.

**`_embedded`.** The container holding the embedded offer objects of a search
result. Offers are large and deeply nested, so the client keeps them as faithful
raw JSON objects rather than narrowing them to a partial type.

**`_links`.** HAL hypermedia links (self, next/prev page, etc.). An offer id
copied from a `_links` href may already be percent-encoded; the client detects
this and does not double-encode it when building the details path.

**`page` (PageInfo).** HAL paging metadata for a search result:
`size`, `totalElements`, `totalPages`, and `number` (the current 0-based page).
`totalElements` is capped at `10000`: a broad query reports exactly `10000`, meaning
"10000 or more", and only those first 10000 results can be paged through.

---

## Identifiers

**Offer id.** The identifier of one apprenticeship offer, passed to
`details <id>`. Offer ids are numeric; the CLI rejects anything else (exit `2`,
before any request), and the library rejects an empty id and a `.`/`..` id
(percent-encoded forms included) with a validation error.

**Location (`orte`).** The place used to scope a search, written as
`Name_lon_lat` with the **longitude first**, e.g. `Köln_6.957_50.938`. With the
latitude first the API silently returns 0 results. On a place search each offer
carries its distance from the place in `abstaende[].abstandInKm`. A place only
restricts the search together with a radius (`uk`); on its own it just adds the
distances, so the CLI requires `--uk` next to `--orte`.

**Profession id (`ids`).** Identifier(s) of a profession/occupation used to scope
a search: the `dkzId` in an offer's `angebot.systematiken[]` (e.g. `9162`,
Staatlich anerkannter Erzieher). Several ids can be comma-separated. This is the
only working occupation filter: the API ignores the keyword `sw`.

**Region / state code (`re`).** The 3-letter code of a Bundesland used to scope a
search: `BAW`, `BAY`, `BER`, `BRA`, `BRE`, `HAM`, `HES`, `MBV`, `NDS`, `NRW`,
`RPF`, `SAA`, `SAC`, `SAN`, `SLH`, `THÜ`. Several can be comma-separated. An
offer's code is in `adresse.ortStrasse.land.code`; the 2-letter abbreviations
(e.g. `BW`) get HTTP 400, so the CLI rejects any other code (exit `2`); it
uppercases a lowercase one (`nrw` → `NRW`).

---

## Filter values, units & enums

**Offer type (`sty`).** A small integer code `0`..`3` selecting the kind of
offer/search. The API rejects `4` with HTTP 400; the CLI rejects anything outside
`0`..`3` (exit `2`).

**Radius (`uk`, Umkreis).** The search radius around the location, in
**kilometres** — `10`, `25`, `50` or `100` — or the literal string `Bundesweit`
("nationwide") to search the whole country with no radius limit. Other values
(e.g. `30`, `150`, `200`) get HTTP 400, so the CLI rejects them (exit `2`);
`bundesweit` in any case is sent as `Bundesweit`. A kilometre radius needs a location
(`orte`): without one the API ignores it, so the CLI rejects `--uk 25` without
`--orte`.

**Training type (`bart`, Bildungsart).** The category of training/education being
searched.

**Education voucher (`bg`, Bildungsgutschein).** A boolean filter restricting
results to offers eligible for a *Bildungsgutschein* — a state-issued voucher
that funds an approved training measure.

**Start date (`bt`, Beginntermin).** A code for the desired training start, not a
date: per the upstream API description `2` means earlier dates and `101`..`112`
January..December of the following year. `0` and `1` are accepted too (their meaning
is undocumented); any other value gets HTTP 400, so the CLI rejects it (exit `2`).
Several codes can be comma-separated.

**Page (`page`).** Zero-based page index for paging through search results. The
API serves at most 10000 results of a query, so `(page + 1) × size` must be at most
`10000` (with the default size 20, the last page is `499`); a later page gets HTTP 500,
so the CLI rejects it (exit `2`).

**Page size (`size`).** Number of results per page, an integer `1`..`2000`.
`MAX_PAGE_SIZE` is `2000`; the server silently overrides `size=0` (to 20) and
ignores oversized values, so the CLI rejects anything outside `1..2000` up front.
In practice the server returns at most **20** rows per page: a larger `size` comes
back as `page.size` 20.

---

## Exit codes

**Exit codes.** The CLI maps outcomes to process exit codes: `0` success;
`2` usage / argument-validation errors; `3` on `401`/`403` (rejected request,
often the API key); `4` on `404`; `5` on `406` (Accept negotiation failed);
`6` on a network / transport failure (DNS, connection, timeout, response-size
cap); `1` for any other error. `--help`/`--version` return `0`.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `AusbildungssucheClient`, the request engine, transport, retry/backoff, error
> types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.
