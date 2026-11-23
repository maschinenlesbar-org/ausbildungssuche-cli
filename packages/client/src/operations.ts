// The use cases of the skills as library functions, built on the client: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
// - findTraining: a ranked, de-duplicated shortlist of offers near a place or in a region, an
//   occupation word resolved to its ids first (ausbildung-finder);
// - scanMarket: the market for an occupation as counts per Bundesland, training type, offer
//   type or funding, with the capped counts marked (ausbildung-market-scan);
// - offerBrief: one offer as a clean briefing: HTML stripped, dates in Europe/Berlin, the cost
//   stated honestly, the venue (not the provider's office) (ausbildung-offer-brief);
// - findOccupations: the occupation ids (dkzId) for a word, read from a sample of offers;
// - searchOffers: a slice of offers in the API's order.
//
// Traps that hold for all of them: the keyword filter (`sw`) is ignored by the API, so it is
// never sent: only the occupation ids narrow by occupation, and the API has no lookup for them;
// a place is `Name_lon_lat` with the longitude first, and the other order silently finds nothing
// (coordinates given the other way round for Germany are swapped back, and said so); a place
// needs a radius (10, 25, 50 or 100 km); the Bundesländer are the API's 3-letter codes (names and
// the usual 2-letter abbreviations are mapped); `totalElements` stops at 10000 (capped); at most
// 20 offers per page, in no useful order; the same course is listed once per run (town and date);
// dates are epoch milliseconds at midnight in Germany. Ambiguity is reported, never guessed; an
// empty answer says what was searched and what to change.

import type { AusbildungssucheClient } from "./client.js";
import { AusbildungApiError, AusbildungValidationError } from "./errors.js";
import type { AusbildungSearchParams, AusbildungSearchResult, JsonObject, JsonValue } from "./types.js";
import { MAX_PAGE_SIZE, MAX_RESULT_WINDOW, normalizeText, offerIdProblem, REGION_CODES, textProblem } from "./validate.js";

/** What every operation answers: ok, ambiguous (ask which), or empty (with the reason). */
export type OperationStatus = "ok" | "ambiguous" | "empty";

// --- Shared ----------------------------------------------------------------------------------

/** The training types (`bart`, Bildungsart) by name. */
export const TRAINING_TYPES = { "basic-qualification": "101", apprenticeship: "102", "further-training": "104" } as const;
export type TrainingType = keyof typeof TRAINING_TYPES;

/** The radii in km the API accepts with a place (`uk`); anything else is HTTP 400. */
export const RADII_KM = [10, 25, 50, 100] as const;
export type RadiusKm = (typeof RADII_KM)[number];

/** The radius used when a place comes without one. */
export const DEFAULT_RADIUS_KM: RadiusKm = 25;

/** The most offers the API answers per page, and the size every operation reads with. */
export const OFFER_PAGE_SIZE = MAX_PAGE_SIZE;

/** `totalElements` stops here: a count of 10000 means "10000 or more". */
export const COUNT_CAP = MAX_RESULT_WINDOW;

/** The Bundesländer: the API's code, its name. */
export const REGIONS: Record<(typeof REGION_CODES)[number], string> = {
  BAW: "Baden-Württemberg",
  BAY: "Bayern",
  BER: "Berlin",
  BRA: "Brandenburg",
  BRE: "Bremen",
  HAM: "Hamburg",
  HES: "Hessen",
  MBV: "Mecklenburg-Vorpommern",
  NDS: "Niedersachsen",
  NRW: "Nordrhein-Westfalen",
  RPF: "Rheinland-Pfalz",
  SAA: "Saarland",
  SAC: "Sachsen",
  SAN: "Sachsen-Anhalt",
  SLH: "Schleswig-Holstein",
  THÜ: "Thüringen",
};

/** The usual 2-letter abbreviations (ISO 3166-2:DE), which the API refuses, mapped to its codes. */
const ABBREVIATIONS: Record<string, string> = {
  BW: "BAW", BY: "BAY", BE: "BER", BB: "BRA", HB: "BRE", HH: "HAM", HE: "HES", MV: "MBV",
  NI: "NDS", NW: "NRW", RP: "RPF", SL: "SAA", SN: "SAC", ST: "SAN", SH: "SLH", TH: "THÜ",
};

/** Lower case, no accents or umlaut dots, ß as ss, single spaces: for matching words and names. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase().replace(/\s+/g, " ").trim();
}

const REGION_BY_FOLDED = new Map<string, string>();
for (const [code, name] of Object.entries(REGIONS)) {
  REGION_BY_FOLDED.set(fold(code), code);
  REGION_BY_FOLDED.set(fold(name), code);
}
for (const [short, code] of Object.entries(ABBREVIATIONS)) REGION_BY_FOLDED.set(fold(short), code);
REGION_BY_FOLDED.set("thu", "THÜ");
REGION_BY_FOLDED.set("thueringen", "THÜ");
REGION_BY_FOLDED.set("baden-wuerttemberg", "BAW");

/**
 * The API's 3-letter code for a Bundesland given as its code (`NRW`), its name (`Bayern`) or the
 * usual 2-letter abbreviation (`BY`), in any case: the API answers `BY` with HTTP 400.
 */
export function regionCode(region: string): string {
  const code = REGION_BY_FOLDED.get(fold(region));
  if (code === undefined) {
    throw new AusbildungValidationError(`Unknown Bundesland "${region.slice(0, 40)}": give its name (Bayern), its code (${REGION_CODES.join(", ")}) or its abbreviation (BY).`);
  }
  return code;
}

/** A place: a name and its coordinates (the API has no lookup by name alone). */
export interface Place {
  name: string;
  longitude: number;
  latitude: number;
}

/** The filters every search operation takes. */
export interface OfferFilters {
  /** Occupation ids (dkzId, from `angebot.systematiken[]` or findOccupations): the only occupation filter. */
  occupationIds?: readonly (string | number)[] | undefined;
  /** Search around this place; needs a radius (default 25 km). */
  place?: Place | undefined;
  /** 10, 25, 50 or 100 km around `place`. */
  radiusKm?: number | undefined;
  /** Bundesländer: names, the API's codes or the 2-letter abbreviations. */
  regions?: readonly string[] | undefined;
  trainingType?: TrainingType | undefined;
  /** Only offers that can be funded with a Bildungsgutschein (`bg`). */
  voucherOnly?: boolean | undefined;
}

/** The filters as an answer echoes them (`searched`): only those given. */
export interface Searched {
  occupationIds?: string[];
  place?: string;
  radiusKm?: number;
  regions?: string[];
  trainingType?: string;
  voucherOnly?: boolean;
}

/** What was done with the place, when that is not simply the place given. */
export interface PlaceNote {
  swapped: boolean;
  note: string;
}

/** Germany's extent, with a margin: a place given the other way round lands outside it. */
const GERMANY = { lon: [5.5, 15.5], lat: [47, 55.5] } as const;
const inGermany = (lon: number, lat: number): boolean => lon >= GERMANY.lon[0] && lon <= GERMANY.lon[1] && lat >= GERMANY.lat[0] && lat <= GERMANY.lat[1];

/** One filter set, checked, as the client's search parameters and as `searched`. */
export interface PreparedSearch {
  params: AusbildungSearchParams;
  searched: Searched;
  place?: PlaceNote;
}

const textOf = (name: string, value: string): string => {
  const problem = textProblem(value);
  if (problem !== undefined) throw new AusbildungValidationError(`Invalid ${name}: ${problem}`);
  return normalizeText(value);
};

/** The search parameters for `filters`, checked: a usage error before any request. */
export function prepareSearch(filters: OfferFilters): PreparedSearch {
  const params: AusbildungSearchParams = {};
  const searched: Searched = {};
  let placeNote: PlaceNote | undefined;
  if (filters.occupationIds !== undefined) {
    const ids = filters.occupationIds.map((id) => String(id).trim());
    if (ids.length === 0 || ids.some((id) => !/^[1-9]\d{0,17}$/.test(id))) {
      throw new AusbildungValidationError("Invalid occupationIds: expected one or more occupation ids (dkzId), whole numbers such as 135349; 0 is no usable id.");
    }
    params.ids = [...new Set(ids)].join(",");
    searched.occupationIds = [...new Set(ids)];
  }
  if (filters.radiusKm !== undefined && filters.place === undefined) {
    throw new AusbildungValidationError("radiusKm needs a place: the radius is measured around it. For a whole Bundesland use regions.");
  }
  if (filters.place !== undefined) {
    const { longitude, latitude } = filters.place;
    const name = textOf("place name", filters.place.name);
    if (name.includes(",") || name.includes("_")) throw new AusbildungValidationError("Invalid place name: no commas or underscores (the API separates places and coordinates with them).");
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
      throw new AusbildungValidationError("Invalid place: longitude is -180..180 and latitude -90..90 (Köln: longitude 6.957, latitude 50.938).");
    }
    let lon = longitude;
    let lat = latitude;
    if (!inGermany(lon, lat) && inGermany(lat, lon)) {
      [lon, lat] = [lat, lon];
      placeNote = {
        swapped: true,
        note: `The coordinates were the other way round (in Germany the longitude is about 6-15, the latitude 47-55); searched around ${name} at longitude ${lon}, latitude ${lat}. The other order finds nothing, silently.`,
      };
    }
    const radius = filters.radiusKm ?? DEFAULT_RADIUS_KM;
    if (!(RADII_KM as readonly number[]).includes(radius)) {
      throw new AusbildungValidationError(`Invalid radiusKm: the API takes only ${RADII_KM.join(", ")} km around a place (others are HTTP 400); for a whole Bundesland use regions.`);
    }
    params.orte = `${name}_${lon}_${lat}`;
    params.uk = String(radius);
    searched.place = `${name} (longitude ${lon}, latitude ${lat})`;
    searched.radiusKm = radius;
  }
  if (filters.regions !== undefined) {
    if (filters.regions.length === 0) throw new AusbildungValidationError("Invalid regions: give at least one Bundesland, or leave regions out for all.");
    const codes = [...new Set(filters.regions.map(regionCode))];
    params.re = codes.join(",");
    searched.regions = codes;
  }
  if (filters.trainingType !== undefined) {
    const bart = (TRAINING_TYPES as Record<string, string>)[filters.trainingType];
    if (bart === undefined) throw new AusbildungValidationError(`Invalid trainingType: expected one of ${Object.keys(TRAINING_TYPES).join(", ")}.`);
    params.bart = bart;
    searched.trainingType = filters.trainingType;
  }
  if (filters.voucherOnly === true) {
    params.bg = true;
    searched.voucherOnly = true;
  }
  return { params, searched, ...(placeNote === undefined ? {} : { place: placeNote }) };
}

/** Why a search found nothing, and what to change: never read as "there are none". */
export function emptyReason(searched: Searched): string {
  const hints: string[] = [];
  if (searched.place !== undefined) {
    hints.push("check that the place's longitude comes first (Köln: 6.957, then 50.938)");
    if (searched.radiusKm !== 100) hints.push("widen radiusKm (10, 25, 50, 100)");
    hints.push("or search a whole Bundesland (regions) or nationwide");
  }
  if (searched.occupationIds !== undefined) hints.push("add related occupation ids (findOccupations), or check the ids: the API answers an unknown id with nothing, not an error");
  if (searched.voucherOnly === true) hints.push("drop voucherOnly");
  if (searched.trainingType !== undefined) hints.push("drop trainingType");
  return `No offers matched ${JSON.stringify(searched)}.${hints.length > 0 ? ` To find some: ${hints.join("; ")}.` : ""}`;
}

/** A Termin (one run of an offer) of a search answer, as the API sends it. */
type Termin = JsonObject;

const obj = (value: JsonValue | undefined): JsonObject | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined);
const str = (value: JsonValue | undefined): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const num = (value: JsonValue | undefined): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const label = (value: JsonValue | undefined): string | undefined => str(obj(value)?.["bezeichnung"]);

/** The offers (`_embedded.termine`) of a search answer: absent when nothing matched, which is not an error. */
export function termineOf(result: AusbildungSearchResult): Termin[] {
  const list = result._embedded?.["termine"];
  return Array.isArray(list) ? (list.filter((t) => obj(t) !== undefined) as Termin[]) : [];
}

/** Every match (`page.totalElements`), at most COUNT_CAP. */
export const totalOf = (result: AusbildungSearchResult): number => result.page?.totalElements ?? 0;

const BERLIN_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" });

/**
 * A date of the API (epoch milliseconds at midnight in Germany) as YYYY-MM-DD in Europe/Berlin:
 * in UTC it reads as the day before.
 */
export function berlinDate(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : BERLIN_DATE.format(new Date(ms));
}

/** An occupation an offer is classified under. `dkzId` is left out when it is 0 (no usable id). */
export interface Occupation {
  dkzId?: number;
  name: string;
}

function occupationsOf(angebot: JsonObject | undefined): Occupation[] {
  const list = angebot?.["systematiken"];
  if (!Array.isArray(list)) return [];
  const out: Occupation[] = [];
  for (const item of list) {
    const s = obj(item);
    const name = str(s?.["kurzbezeichnung"]);
    if (name === undefined) continue;
    const id = num(s?.["dkzId"]);
    out.push(id === undefined || id === 0 ? { name } : { dkzId: id, name });
  }
  return out;
}

/** One offer run, short: what a shortlist or a slice shows of it. */
export interface Offer {
  /** The run's id: the input to offerBrief / `details`. */
  id: number;
  /** The offer's id: the same course at other towns or dates shares it. */
  offerId?: number;
  title?: string;
  provider?: string;
  trainingType?: string;
  town?: string;
  postcode?: string;
  region?: string;
  /** Kilometres from the place searched (only with a place), as the API computes it per venue. */
  distanceKm?: number;
  /** YYYY-MM-DD (Europe/Berlin), "rolling" (start any time) or left out (not fixed). */
  start?: string;
  end?: string;
  /** True: can be funded (e.g. with a Bildungsgutschein). */
  funded?: boolean;
  format?: string;
  duration?: string;
  schedule?: string;
  occupations?: Occupation[];
}

/** A run of a search answer in short. Missing fields stay missing ("not given"), never null. */
export function offerOf(termin: Termin): Offer {
  const angebot = obj(termin["angebot"]);
  const address = obj(obj(termin["adresse"])?.["ortStrasse"]);
  const distances = termin["abstaende"];
  const distance = Array.isArray(distances) ? num(obj(distances[0])?.["abstandInKm"]) : undefined;
  const rolling = termin["individuellerEinstieg"] === true;
  const out: Offer = { id: num(termin["id"]) ?? 0 };
  const set = <K extends keyof Offer>(key: K, value: Offer[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set("offerId", num(angebot?.["id"]));
  set("title", str(angebot?.["titel"]));
  set("provider", str(obj(angebot?.["bildungsanbieter"])?.["name"]));
  set("trainingType", label(angebot?.["bildungsart"]));
  set("town", str(address?.["name"]));
  set("postcode", str(address?.["plz"]));
  set("region", str(obj(address?.["land"])?.["name"]));
  set("distanceKm", distance === undefined ? undefined : Math.round(distance * 10) / 10);
  set("start", rolling ? "rolling" : berlinDate(num(termin["beginn"])));
  set("end", berlinDate(num(termin["ende"])));
  if (typeof termin["foerderung"] === "boolean") out.funded = termin["foerderung"];
  set("format", label(termin["unterrichtsform"]));
  set("duration", label(termin["dauer"]));
  set("schedule", label(termin["unterrichtszeit"]));
  const occupations = occupationsOf(angebot);
  if (occupations.length > 0) out.occupations = occupations;
  return out;
}

/** Why `value` is not a whole number from `min` to `max`, as a usage error. */
function whole(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new AusbildungValidationError(`Invalid ${name}: expected a whole number from ${min} to ${max}.`);
  return n;
}

/** Up to `pages` pages of a search, from page 0, stopping at the last; the first page's answer and every run read. */
async function readPages(client: AusbildungssucheClient, params: AusbildungSearchParams, pages: number): Promise<{ total: number; termine: Termin[]; pagesRead: number }> {
  const first = await client.search({ ...params, page: 0, size: OFFER_PAGE_SIZE });
  const total = totalOf(first);
  const termine = termineOf(first);
  const available = Math.ceil(Math.min(total, COUNT_CAP) / OFFER_PAGE_SIZE);
  let pagesRead = 1;
  for (let page = 1; page < Math.min(pages, available); page++) {
    termine.push(...termineOf(await client.search({ ...params, page, size: OFFER_PAGE_SIZE })));
    pagesRead++;
  }
  return { total, termine, pagesRead };
}

// --- findOccupations -------------------------------------------------------------------------

/** An occupation id found for a word. */
export interface OccupationCandidate {
  dkzId: number;
  name: string;
  /** The classification code (`codeNr`). */
  code?: string;
  /** Offers of the sample classified under it. */
  seen: number;
  /** "name": the word is in the name; "synonym": only in its search words. */
  matched: "name" | "synonym";
}

export interface FindOccupationsInput extends Omit<OfferFilters, "occupationIds"> {
  /** A job word ("Pflege", "Tischler", "Erzieher"). */
  word: string;
  /** Pages of 20 offers to sample (1–10, default 5). */
  pages?: number | undefined;
}

export interface OccupationsAnswer {
  status: OperationStatus;
  word: string;
  searched: Searched;
  place?: PlaceNote;
  /** Offers sampled, and every offer of the scope. */
  sampled: number;
  total: number;
  candidates?: OccupationCandidate[];
  /** Occupations whose name matched but that carry no usable id (dkzId 0) in the sample. */
  withoutId?: string[];
  note: string;
  reason?: string;
}

/**
 * The occupation ids (dkzId) for `word`, read from a sample of offers (the first pages of a search
 * in the scope given; the API has no occupation lookup, and its keyword filter is ignored): the
 * occupations whose name contains the word, else those whose search words do (`suchworte`, which
 * the API sends as `{ "suchwort": "…" }` objects; plain strings count too). dkzId 0 is no usable
 * id and only named (`withoutId`).
 */
export async function findOccupations(client: AusbildungssucheClient, input: FindOccupationsInput): Promise<OccupationsAnswer> {
  const word = textOf("word", input.word);
  const needle = fold(word);
  if (needle.length < 3) throw new AusbildungValidationError("Invalid word: give at least 3 letters of the job (\"Pflege\", \"Tischler\").");
  const pages = whole("pages", input.pages, 5, 1, 10);
  const prepared = prepareSearch(input);
  const { total, termine } = await readPages(client, prepared.params, pages);
  const byId = new Map<number, OccupationCandidate>();
  const withoutId = new Set<string>();
  for (const termin of termine) {
    const list = obj(termin["angebot"])?.["systematiken"];
    if (!Array.isArray(list)) continue;
    const counted = new Set<number>();
    for (const item of list) {
      const s = obj(item);
      const name = str(s?.["kurzbezeichnung"]);
      if (name === undefined) continue;
      const id = num(s?.["dkzId"]) ?? 0;
      const byName = fold(name).includes(needle);
      const words = s?.["suchworte"];
      const bySynonym = !byName && Array.isArray(words) && words.some((w) => {
        const synonym = typeof w === "string" ? w : str(obj(w)?.["suchwort"]);
        return synonym !== undefined && fold(synonym).includes(needle);
      });
      if (!byName && !bySynonym) continue;
      if (id === 0) {
        if (byName) withoutId.add(name);
        continue;
      }
      const known = byId.get(id);
      if (known === undefined) {
        const code = str(s?.["codeNr"]);
        byId.set(id, { dkzId: id, name, ...(code === undefined ? {} : { code }), seen: 1, matched: byName ? "name" : "synonym" });
      } else if (!counted.has(id)) known.seen++;
      counted.add(id);
    }
  }
  const candidates = [...byId.values()].sort((a, b) => (a.matched === b.matched ? 0 : a.matched === "name" ? -1 : 1) || b.seen - a.seen || a.dkzId - b.dkzId);
  const note = `A sample: the occupations of the first ${termine.length} of ${total >= COUNT_CAP ? "10000+" : total} offers in this scope (the API has no occupation lookup and ignores keywords). An occupation not in the sample is missing: sample more pages, another scope, or ask the user for the id.`;
  const base = { word, searched: prepared.searched, ...(prepared.place === undefined ? {} : { place: prepared.place }), sampled: termine.length, total, ...(withoutId.size > 0 ? { withoutId: [...withoutId].sort() } : {}), note };
  if (candidates.length === 0) {
    return {
      status: "empty",
      ...base,
      reason: `No occupation with "${word}" in its name or search words in the sample${withoutId.size > 0 ? " (only some without a usable id, dkzId 0)" : ""}. Try another word (a job title, "Pflegefachmann" rather than "Krankenschwester"), more pages, a scope where the training is offered, or ask for the id.`,
    };
  }
  return { status: "ok", ...base, candidates };
}

/** How an occupation word became ids (`occupation` of an answer). */
export interface ResolvedOccupation {
  word: string;
  ids: Occupation[];
  note: string;
}

type Resolution = { ids: string[]; resolved: ResolvedOccupation } | { answer: OccupationsAnswer };

/**
 * `word` as occupation ids: one candidate is used; several are used only when exactly one has the
 * word as a whole part of its name ("Tischler" in "Tischler/Tischlerin"); else ambiguous. Without
 * a training type the sample is of apprenticeships first (what most ask for, and more kinds of
 * occupation than the first pages of everything, which near a city are mostly short courses),
 * then, when that finds none, of every offer in the scope.
 */
async function resolveOccupation(client: AusbildungssucheClient, word: string, scope: Omit<OfferFilters, "occupationIds">, pages: number | undefined): Promise<Resolution> {
  let answer = await findOccupations(client, { ...scope, trainingType: scope.trainingType ?? "apprenticeship", word, pages });
  if (answer.status === "empty" && scope.trainingType === undefined) answer = await findOccupations(client, { ...scope, word, pages });
  if (answer.status !== "ok" || answer.candidates === undefined) return { answer };
  const byName = answer.candidates.filter((c) => c.matched === "name");
  const pool = byName.length > 0 ? byName : answer.candidates;
  const needle = fold(word);
  const whole = pool.filter((c) => fold(c.name).split(/[/()\s,-]+/).includes(needle));
  const chosen = pool.length === 1 ? pool : whole.length === 1 ? whole : undefined;
  if (chosen === undefined) return { answer: { ...answer, status: "ambiguous", candidates: pool, reason: `"${word}" matches ${pool.length} occupations: ask which (one or several) and call again with their occupationIds.` } };
  const pick = chosen[0] as OccupationCandidate;
  return { ids: [String(pick.dkzId)], resolved: { word, ids: [{ dkzId: pick.dkzId, name: pick.name }], note: `"${word}" resolved to ${pick.name} (dkzId ${pick.dkzId}) from a sample of ${answer.sampled} offers.` } };
}

// --- findTraining (ausbildung-finder) --------------------------------------------------------

export interface FindTrainingInput extends OfferFilters {
  /** A job word, resolved to occupation ids when no occupationIds are given. */
  occupation?: string | undefined;
  /** Picks on the shortlist (1–25, default 10). */
  limit?: number | undefined;
  /** Pages of 20 read and ranked (1–10, default 5); also the occupation sample's pages. */
  maxPages?: number | undefined;
  /** The clock for "rolling" starts (tests). */
  now?: (() => number) | undefined;
}

export interface TrainingPick extends Offer {
  /** Other runs of the same offer (other towns or dates) merged into this pick. */
  moreRuns?: number;
  /** Their towns, when others than this pick's. */
  otherTowns?: string[];
}

export interface TrainingShortlist {
  status: OperationStatus;
  searched: Searched;
  place?: PlaceNote;
  occupation?: ResolvedOccupation;
  /** Every match: 10000 means 10000 or more (capped). */
  total?: number;
  capped?: boolean;
  /** Runs read and ranked; complete when that is every match. */
  read?: number;
  complete?: boolean;
  /** Runs merged into another pick of the same offer. */
  runsMerged?: number;
  sortedBy?: "distance" | "start";
  picks?: TrainingPick[];
  /** Offers read but not on the shortlist. */
  more?: number;
  note?: string;
  reason?: string;
  candidates?: OccupationCandidate[];
  withoutId?: string[];
}

/** Sorts a run by its start: a rolling start is "now", a fixed date that date, none last. */
function startKey(offer: Offer, now: number): number {
  if (offer.start === "rolling") return now;
  if (offer.start === undefined) return Number.POSITIVE_INFINITY;
  return Date.parse(`${offer.start}T00:00:00Z`);
}

/**
 * A shortlist of offers: the occupation word resolved to ids first (never the ignored keyword
 * filter), up to `maxPages` pages read, the runs of one offer merged (the nearest or earliest
 * kept, "+N more runs"), ranked by distance with a place, else by start; rolling starts count as
 * "now", not last.
 */
export async function findTraining(client: AusbildungssucheClient, input: FindTrainingInput): Promise<TrainingShortlist> {
  const limit = whole("limit", input.limit, 10, 1, 25);
  const maxPages = whole("maxPages", input.maxPages, 5, 1, 10);
  const now = (input.now ?? Date.now)();
  let filters: OfferFilters = input;
  let occupation: ResolvedOccupation | undefined;
  prepareSearch(input); // the filters are checked before any request
  if (input.occupationIds === undefined && input.occupation !== undefined) {
    const resolution = await resolveOccupation(client, input.occupation, { place: input.place, radiusKm: input.radiusKm, regions: input.regions, trainingType: input.trainingType }, maxPages);
    if ("answer" in resolution) {
      const { answer } = resolution;
      return {
        status: answer.status,
        searched: answer.searched,
        ...(answer.place === undefined ? {} : { place: answer.place }),
        ...(answer.candidates === undefined ? {} : { candidates: answer.candidates }),
        ...(answer.withoutId === undefined ? {} : { withoutId: answer.withoutId }),
        note: answer.note,
        ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      };
    }
    filters = { ...input, occupationIds: resolution.ids };
    occupation = resolution.resolved;
  }
  const prepared = prepareSearch(filters);
  const base = { searched: prepared.searched, ...(prepared.place === undefined ? {} : { place: prepared.place }), ...(occupation === undefined ? {} : { occupation }) };
  const { total, termine } = await readPages(client, prepared.params, maxPages);
  if (total === 0 || termine.length === 0) return { status: "empty", ...base, total, reason: emptyReason(prepared.searched) };
  const sortedBy = prepared.params.orte !== undefined ? "distance" : "start";
  const offers = termine.map(offerOf);
  const order = (a: Offer, b: Offer): number =>
    (sortedBy === "distance" ? (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) : 0) ||
    startKey(a, now) - startKey(b, now) ||
    Number(b.funded === true) - Number(a.funded === true) ||
    a.id - b.id;
  offers.sort(order);
  const groups = new Map<string, TrainingPick & { towns: Set<string> }>();
  for (const offer of offers) {
    const key = offer.offerId !== undefined ? `id:${offer.offerId}` : `t:${fold(offer.title ?? "")}|${fold(offer.provider ?? "")}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { ...offer, towns: new Set() });
    else {
      group.moreRuns = (group.moreRuns ?? 0) + 1;
      if (offer.town !== undefined && offer.town !== group.town) group.towns.add(offer.town);
    }
  }
  const all = [...groups.values()].map(({ towns, ...pick }) => (towns.size > 0 ? { ...pick, otherTowns: [...towns].slice(0, 5) } : pick));
  const complete = termine.length >= Math.min(total, COUNT_CAP);
  return {
    status: "ok",
    ...base,
    total,
    capped: total >= COUNT_CAP,
    read: termine.length,
    complete,
    runsMerged: termine.length - all.length,
    sortedBy,
    picks: all.slice(0, limit),
    more: Math.max(0, all.length - limit),
    ...(complete ? {} : { note: `Ranked the first ${termine.length} of ${total >= COUNT_CAP ? "10000+" : total} runs (the API returns them in no useful order): narrow the search (occupation, a smaller radius, a Bundesland) for a complete ranking.` }),
  };
}

// --- scanMarket (ausbildung-market-scan) ------------------------------------------------------

/** What scanMarket compares. */
export const SCAN_DIMENSIONS = ["region", "trainingType", "offerType", "funding"] as const;
export type ScanDimension = (typeof SCAN_DIMENSIONS)[number];

export interface ScanMarketInput extends OfferFilters {
  occupation?: string | undefined;
  /** The dimension swept (default region: the 16 Bundesländer, or those given in regions). */
  by?: ScanDimension | undefined;
  /** Also count each cell's Bildungsgutschein-eligible offers (twice the requests). */
  withFunding?: boolean | undefined;
  /** Tally the providers of the whole filtered set, up to maxPages pages of 20. */
  providers?: boolean | undefined;
  /** Pages for the provider tally and the occupation sample (1–10, default 5). */
  maxPages?: number | undefined;
}

/** One cell of the comparison. */
export interface MarketCell {
  label: string;
  /** The API's value of the swept filter. */
  code: string;
  offers: number;
  /** True when offers is the API's cap: 10000 or more, not an exact figure. */
  capped: boolean;
  funded?: number;
  fundedCapped?: boolean;
  /** funded ÷ offers, only when neither is capped. */
  fundedShare?: number;
}

export interface MarketScan {
  status: OperationStatus;
  searched: Searched;
  place?: PlaceNote;
  occupation?: ResolvedOccupation;
  by?: ScanDimension;
  /** Every match of the other filters, without the swept one (by region: every Land); 10000 means 10000 or more. */
  total?: number;
  capped?: boolean;
  cells?: MarketCell[];
  providers?: { top: { name: string; runs: number; offers: number }[]; runsRead: number; complete: boolean };
  requests?: number;
  note?: string;
  reason?: string;
  candidates?: OccupationCandidate[];
  withoutId?: string[];
}

/** The cells of a dimension: label, the parameter it sets, its value. */
function cellsOf(by: ScanDimension, regions: string[] | undefined): { label: string; code: string; params: AusbildungSearchParams }[] {
  switch (by) {
    case "region":
      return (regions ?? Object.keys(REGIONS)).map((code) => ({ label: REGIONS[code as keyof typeof REGIONS], code, params: { re: code } }));
    case "trainingType":
      return Object.entries(TRAINING_TYPES).map(([name, code]) => ({ label: name, code, params: { bart: code } }));
    case "offerType":
      return [0, 1, 2, 3].map((sty) => ({ label: `offer type ${sty}`, code: String(sty), params: { sty } }));
    case "funding":
      return [{ label: "Bildungsgutschein-eligible", code: "bg", params: { bg: true } }];
  }
}

/** The search parameter each dimension sets per cell: the total is counted without it. */
const SWEPT_PARAM: Record<ScanDimension, keyof AusbildungSearchParams> = { region: "re", trainingType: "bart", offerType: "sty", funding: "bg" };

/** Runs `tasks` with at most `width` at a time, in order. */
async function pooled<T>(tasks: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      out[index] = await (tasks[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker));
  return out;
}

/**
 * The market as counts, not offers: one request of size 1 per cell reads `page.totalElements`;
 * a count of 10000 is the cap (`capped`, "10000+"), never compared as exact. The per-Land counts
 * need not add up to the national total. Providers are tallied from up to `maxPages` pages.
 */
export async function scanMarket(client: AusbildungssucheClient, input: ScanMarketInput): Promise<MarketScan> {
  const by = input.by ?? "region";
  if (!(SCAN_DIMENSIONS as readonly string[]).includes(by)) throw new AusbildungValidationError(`Invalid by: expected one of ${SCAN_DIMENSIONS.join(", ")}.`);
  const maxPages = whole("maxPages", input.maxPages, 5, 1, 10);
  prepareSearch(input);
  let filters: OfferFilters = input;
  let occupation: ResolvedOccupation | undefined;
  if (input.occupationIds === undefined && input.occupation !== undefined) {
    const resolution = await resolveOccupation(client, input.occupation, { regions: input.regions, trainingType: input.trainingType, place: input.place, radiusKm: input.radiusKm }, maxPages);
    if ("answer" in resolution) {
      const { answer } = resolution;
      return {
        status: answer.status,
        searched: answer.searched,
        ...(answer.place === undefined ? {} : { place: answer.place }),
        ...(answer.candidates === undefined ? {} : { candidates: answer.candidates }),
        ...(answer.withoutId === undefined ? {} : { withoutId: answer.withoutId }),
        note: answer.note,
        ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      };
    }
    filters = { ...input, occupationIds: resolution.ids };
    occupation = resolution.resolved;
  }
  const prepared = prepareSearch(filters);
  const base = { searched: prepared.searched, ...(prepared.place === undefined ? {} : { place: prepared.place }), ...(occupation === undefined ? {} : { occupation }), by };
  let requests = 0;
  const count = async (params: AusbildungSearchParams): Promise<number> => {
    requests++;
    return totalOf(await client.search({ ...params, page: 0, size: 1 }));
  };
  // The total counts without the swept filter (each cell sets its own), so a cell over the total
  // is its share; by region the regions given choose the cells, and the total is every Land's.
  const sweptParam = SWEPT_PARAM[by];
  const { [sweptParam]: _swept, ...unswept } = prepared.params;
  const total = await count(unswept);
  if (total === 0) return { status: "empty", ...base, total, requests, reason: emptyReason(prepared.searched) };
  const swept = by === "region" ? (prepared.searched.regions ?? undefined) : undefined;
  const cells = cellsOf(by, swept);
  // A cell's value replaces the filter's own (by region: one Land instead of the ones given).
  const sweepParams = (extra: AusbildungSearchParams): AusbildungSearchParams => ({ ...prepared.params, ...extra });
  const replaced = by === "trainingType" && input.trainingType !== undefined ? "trainingType" : by === "funding" && input.voucherOnly === true ? "voucherOnly" : undefined;
  const funding = input.withFunding === true && by !== "funding";
  const counted = await pooled(
    cells.map((cell) => async (): Promise<MarketCell> => {
      const offers = await count(sweepParams(cell.params));
      const out: MarketCell = { label: cell.label, code: cell.code, offers, capped: offers >= COUNT_CAP };
      if (funding && offers > 0) {
        const funded = await count(sweepParams({ ...cell.params, bg: true }));
        out.funded = funded;
        out.fundedCapped = funded >= COUNT_CAP;
        if (!out.capped && !out.fundedCapped) out.fundedShare = Math.round((funded / offers) * 1000) / 1000;
      } else if (funding) out.funded = 0;
      if (by === "funding" && offers < COUNT_CAP && total < COUNT_CAP) out.fundedShare = Math.round((offers / total) * 1000) / 1000;
      return out;
    }),
    4,
  );
  counted.sort((a, b) => b.offers - a.offers || a.label.localeCompare(b.label));
  let providers: MarketScan["providers"];
  if (input.providers === true) {
    const { termine, pagesRead } = await readPages(client, prepared.params, maxPages);
    requests += pagesRead;
    const tally = new Map<string, { runs: number; offers: Set<number> }>();
    for (const termin of termine) {
      const offer = offerOf(termin);
      const name = offer.provider ?? "(no provider named)";
      const entry = tally.get(name) ?? { runs: 0, offers: new Set<number>() };
      entry.runs++;
      if (offer.offerId !== undefined) entry.offers.add(offer.offerId);
      tally.set(name, entry);
    }
    const top = [...tally.entries()].map(([name, e]) => ({ name, runs: e.runs, offers: e.offers.size })).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)).slice(0, 15);
    providers = { top, runsRead: termine.length, complete: termine.length >= Math.min(total, COUNT_CAP) };
  }
  const notes = [
    "A count of 10000 is the API's cap: 10000 or more (capped), not comparable as an exact figure; narrow the search for real resolution.",
    by === "region" ? "The per-Land counts need not add up to the total: some offers carry no Land." : undefined,
    replaced === undefined ? undefined : `The ${replaced} given is replaced by the sweep: each cell sets its own, and the total counts without it.`,
    by === "offerType" ? "The offer types (sty 0-3) are undocumented upstream: compare them, don't name them." : undefined,
    providers !== undefined && !providers.complete ? `Providers are tallied from the first ${providers.runsRead} runs only (a sample).` : undefined,
    occupation === undefined && prepared.searched.occupationIds === undefined ? "No occupation filter: these are counts of the whole catalogue." : undefined,
  ].filter((n): n is string => n !== undefined);
  return { status: "ok", ...base, total, capped: total >= COUNT_CAP, cells: counted, ...(providers === undefined ? {} : { providers }), requests, note: notes.join(" ") };
}

// --- offerBrief (ausbildung-offer-brief) -----------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", reg: "®", copy: "©", trade: "™", euro: "€", ndash: "–", mdash: "—",
  hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä",
  Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à", sect: "§", deg: "°", middot: "·", bull: "•", shy: "",
};

/** A tag's parts (the text between "<" and ">"): a closing one, its name in lower case, the rest. */
function tagParts(tag: string): { closing: boolean; name: string; rest: string } {
  // Read by index, not by a regular expression with two optional runs of spaces, which
  // backtracks over a long run of them.
  let i = 0;
  const spaces = (): void => {
    while (i < tag.length && /\s/.test(tag[i] as string)) i++;
  };
  spaces();
  const closing = tag[i] === "/";
  if (closing) {
    i++;
    spaces();
  }
  const start = i;
  while (i < tag.length && /[a-z0-9]/i.test(tag[i] as string)) i++;
  return { closing, name: tag.slice(start, i).toLowerCase(), rest: tag.slice(i).trim() };
}

/** What a tag becomes: a line break, a bullet, or nothing. */
function tagText({ closing, name, rest }: { closing: boolean; name: string; rest: string }): string {
  if (!closing && name.startsWith("li")) return "\n• ";
  if (!closing && name === "br" && (rest === "" || rest === "/")) return "\n";
  if (closing && rest === "" && /^(p|div|h\d|li|ul|ol|tr|table)$/.test(name)) return "\n";
  return "";
}

/** Elements whose contents no browser shows: dropped whole. */
const HIDDEN_ELEMENTS = new Set(["script", "style"]);

/**
 * `html` with its tags replaced (tagText): a tag runs from "<" to the next ">"; a "<" with no ">"
 * after it is text. A script or style element goes with its contents, up to its closing tag (or
 * the end, when there is none). One pass with indexOf, so linear: a regular expression tried at
 * every "<" rescans the rest of a text without a ">" (quadratic).
 */
function withoutTags(html: string): string {
  const out: string[] = [];
  let at = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", at)) {
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    const tag = tagParts(html.slice(open + 1, close));
    out.push(html.slice(at, open));
    at = close + 1;
    if (tag.closing || !HIDDEN_ELEMENTS.has(tag.name)) {
      out.push(tagText(tag));
      continue;
    }
    // Its closing tag: "</name" (any case, spaces allowed) up to the next ">".
    const end = new RegExp(`<\\s*/\\s*${tag.name}(?![a-z0-9])`, "gi");
    end.lastIndex = at;
    const found = end.exec(html);
    const after = found === null ? -1 : html.indexOf(">", found.index);
    if (after === -1) return out.join("");
    at = after + 1;
  }
  out.push(html.slice(at));
  return out.join("");
}

/** The longest text a briefing section carries. */
export const MAX_SECTION_LENGTH = 3000;

/**
 * An HTML text of the API as plain text: list items as "• " lines, paragraphs, headings and
 * breaks as lines, tags dropped (script and style elements with their contents), entities
 * decoded, blank lines dropped; cut at
 * MAX_SECTION_LENGTH with "…".
 */
export function htmlToText(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const text = withoutTags(html)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name] ?? whole;
    })
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
  if (text === "" || /^keine angabe\.?$/i.test(text)) return undefined;
  return text.length > MAX_SECTION_LENGTH ? `${text.slice(0, MAX_SECTION_LENGTH).trimEnd()}…` : text;
}

const phone = (prefix: JsonValue | undefined, rest: JsonValue | undefined): string | undefined => {
  const a = str(prefix);
  const b = str(rest);
  return b === undefined ? undefined : a === undefined ? b : `${a} ${b}`;
};

/** One offer run as a briefing. */
export interface OfferBriefing {
  status: OperationStatus;
  id: string;
  reason?: string;
  offer?: {
    offerId?: number;
    title?: string;
    trainingType?: string;
    provider?: { name?: string; phone?: string; email?: string; homepage?: string };
    /** Where the course takes place: not the provider's office, which can be in another city. */
    venue?: { street?: string; postcode?: string; town?: string; region?: string };
    start?: string;
    end?: string;
    rolling?: boolean;
    applicationDeadline?: string;
    duration?: string;
    format?: string;
    schedule?: string;
    hours?: string;
    funded?: boolean;
    fundingOptions?: string;
    cost: { text: string; amount?: string; currency?: string; note?: string };
    content?: string;
    qualification?: string;
    entryRequirements?: string;
    audience?: string;
    occupations?: Occupation[];
    link?: string;
    contacts?: { name?: string; phone?: string; email?: string }[];
    dateNotes?: string;
    directions?: string;
    updated?: string;
  };
}

/** The cost, stated honestly: not stated is not free, and 0 EUR alone is "listed as 0 EUR". */
function costOf(termin: Termin): NonNullable<OfferBriefing["offer"]>["cost"] {
  const amount = typeof termin["kostenWert"] === "string" ? termin["kostenWert"].trim() : typeof termin["kostenWert"] === "number" ? String(termin["kostenWert"]) : undefined;
  const currency = str(termin["kostenWaehrung"]);
  const note = htmlToText(str(termin["kostenBemerkung"]));
  const withNote = { ...(note === undefined ? {} : { note }) };
  if (amount === undefined || amount === "") return { text: "not stated", ...withNote };
  if (/^0+([.,]0+)?$/.test(amount)) return { text: `listed as 0 ${currency ?? "EUR"}${note === undefined ? "" : "; see the provider's note"}`, amount, ...(currency === undefined ? {} : { currency }), ...withNote };
  return { text: `${amount} ${currency ?? ""}`.trim(), amount, ...(currency === undefined ? {} : { currency }), ...withNote };
}

/**
 * One offer run by its id (from a search: `_embedded.termine[].id`) as a briefing. The details
 * answer is an array, read at [0]; a gone id (HTTP 404) is status empty with what to do.
 */
export async function offerBrief(client: AusbildungssucheClient, id: string | number): Promise<OfferBriefing> {
  const raw = String(id).trim();
  const problem = offerIdProblem(raw);
  if (problem !== undefined) throw new AusbildungValidationError(`Invalid id: ${problem}`);
  let details;
  try {
    details = await client.details(raw);
  } catch (err) {
    if (err instanceof AusbildungApiError && err.status === 404) {
      return { status: "empty", id: raw, reason: `No offer with id ${raw}: ids change as the catalogue is updated, or the number is mistyped. Search again (findTraining, searchOffers) for a current id.` };
    }
    throw err;
  }
  const termin = obj(details[0] as JsonValue | undefined);
  if (termin === undefined) return { status: "empty", id: raw, reason: `The API answered no record for id ${raw}. Search again for a current id.` };
  const angebot = obj(termin["angebot"]);
  const anbieter = obj(angebot?.["bildungsanbieter"]);
  const adresse = obj(termin["adresse"]);
  const ort = obj(adresse?.["ortStrasse"]);
  const rolling = termin["individuellerEinstieg"] === true;
  const html = (value: JsonValue | undefined): string | undefined => htmlToText(str(value));
  const contacts = Array.isArray(termin["ansprechpartner"])
    ? termin["ansprechpartner"]
        .map((c) => obj(c))
        .filter((c): c is JsonObject => c !== undefined)
        .map((c) => {
          const name = [str(c["titel"]), str(c["vorname"]), str(c["nachname"])].filter((p) => p !== undefined).join(" ");
          const tel = phone(c["telefonVorwahl"], c["telefonDurchwahl"]);
          const email = str(c["email"]);
          return { ...(name === "" ? {} : { name }), ...(tel === undefined ? {} : { phone: tel }), ...(email === undefined ? {} : { email }) };
        })
        .filter((c) => Object.keys(c).length > 0)
    : [];
  const prune = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && !(typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) && !(Array.isArray(v) && v.length === 0))) as T;
  const offerId = num(angebot?.["id"]);
  const occupations = occupationsOf(angebot);
  const offer = prune({
    offerId,
    title: str(angebot?.["titel"]),
    trainingType: label(angebot?.["bildungsart"]),
    provider: prune({
      name: str(anbieter?.["name"]),
      phone: phone(anbieter?.["telefonVorwahl"], anbieter?.["telefonDurchwahl"]),
      email: str(anbieter?.["email"]),
      homepage: str(anbieter?.["homepage"]),
    }),
    venue: prune({ street: str(adresse?.["strasse"]), postcode: str(ort?.["plz"]), town: str(ort?.["name"]), region: str(obj(ort?.["land"])?.["name"]) }),
    start: rolling ? "rolling" : berlinDate(num(termin["beginn"])),
    end: berlinDate(num(termin["ende"])),
    rolling,
    applicationDeadline: berlinDate(num(termin["anmeldeschluss"])),
    duration: label(termin["dauer"]),
    format: label(termin["unterrichtsform"]),
    schedule: label(termin["unterrichtszeit"]),
    hours: html(termin["unterrichtszeiten"]),
    funded: typeof termin["foerderung"] === "boolean" ? termin["foerderung"] : undefined,
    fundingOptions: html(angebot?.["foerderung"]),
    cost: costOf(termin),
    content: html(angebot?.["inhalt"]),
    qualification: html(angebot?.["abschlussbezeichnung"]),
    entryRequirements: html(angebot?.["zugang"]),
    audience: html(angebot?.["zielgruppe"]),
    occupations,
    link: str(angebot?.["link"]) ?? str(termin["link"]),
    contacts,
    dateNotes: html(termin["bemerkungZeit"]),
    directions: html(adresse?.["hinweise"]),
    updated: berlinDate(num(termin["aktualisierungsdatum"])),
  });
  return { status: "ok", id: raw, offer: offer as OfferBriefing["offer"] };
}

// --- searchOffers ----------------------------------------------------------------------------

/** The highest offset a slice can start at: the API pages no further than 10000 offers. */
export const MAX_OFFSET = COUNT_CAP - 1;

export interface SearchOffersInput extends OfferFilters {
  /** 0-based (default 0). */
  offset?: number | undefined;
  /** Offers in the slice (1–50, default 20). */
  limit?: number | undefined;
}

export interface OfferSlice {
  status: OperationStatus;
  searched: Searched;
  place?: PlaceNote;
  total: number;
  capped: boolean;
  offset: number;
  offers?: Offer[];
  nextOffset?: number;
  reason?: string;
}

/** A slice of offers in the API's order (no useful order: findTraining ranks), read in its pages of 20. */
export async function searchOffers(client: AusbildungssucheClient, input: SearchOffersInput): Promise<OfferSlice> {
  const offset = whole("offset", input.offset, 0, 0, MAX_OFFSET);
  const limit = whole("limit", input.limit, 20, 1, 50);
  const prepared = prepareSearch(input);
  const base = { searched: prepared.searched, ...(prepared.place === undefined ? {} : { place: prepared.place }) };
  const end = Math.min(offset + limit, COUNT_CAP);
  const firstPage = Math.floor(offset / OFFER_PAGE_SIZE);
  const lastPage = Math.floor((end - 1) / OFFER_PAGE_SIZE);
  const termine: Termin[] = [];
  let total = 0;
  for (let page = firstPage; page <= lastPage; page++) {
    const result = await client.search({ ...prepared.params, page, size: OFFER_PAGE_SIZE });
    total = totalOf(result);
    const items = termineOf(result);
    termine.push(...items);
    if (items.length < OFFER_PAGE_SIZE) break;
  }
  const skip = offset - firstPage * OFFER_PAGE_SIZE;
  const offers = termine.slice(skip, skip + (end - offset)).map(offerOf);
  if (total === 0) return { status: "empty", ...base, total, capped: false, offset, reason: emptyReason(prepared.searched) };
  if (offers.length === 0) return { status: "empty", ...base, total, capped: total >= COUNT_CAP, offset, reason: `Offset ${offset} is past the last of ${total} offers.` };
  const next = offset + offers.length;
  return { status: "ok", ...base, total, capped: total >= COUNT_CAP, offset, offers, ...(next < Math.min(total, COUNT_CAP) ? { nextOffset: next } : {}) };
}
