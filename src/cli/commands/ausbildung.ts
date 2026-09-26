import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  commaList,
  DEFAULT_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  once,
  parseBoundedInt,
  parseIntArg,
  parseNonEmpty,
  parseOfferId,
  parsePlace,
  parseRadius,
  parseRegions,
  parseSizeArg,
  parseStartCodes,
  renderJson,
} from "../shared.js";
import type { AusbildungSearchParams } from "../../client/types.js";
import { AusbildungValidationError } from "../../client/errors.js";

/**
 * `--orte` and `--uk` only filter together: the API ignores a numeric radius
 * without a place, and a place without a radius does not restrict the search at
 * all (it only adds distances). Either alone would silently return the nationwide
 * set with exit 0, so reject it before any request. `--uk Bundesweit` alone is
 * fine: it asks for exactly what the API returns without a place.
 */
function checkPlaceAndRadius(orte: string | undefined, uk: string | undefined): void {
  if (uk !== undefined && orte === undefined && uk.toLowerCase() !== "bundesweit") {
    throw new AusbildungValidationError(
      `search: --uk ${uk} needs --orte: a radius is measured around a place, and without ` +
        "one the API ignores it. Leave --uk out (or use --uk Bundesweit) for a nationwide search.",
    );
  }
  if (orte !== undefined && uk === undefined) {
    throw new AusbildungValidationError(
      "search: --orte needs --uk: without a radius the API does not restrict the search to " +
        "the place. Add --uk 10, 25, 50 or 100 (km), or --uk Bundesweit to search nationwide " +
        "with distances.",
    );
  }
}

/**
 * The API serves at most MAX_RESULT_WINDOW results of a query over all pages and
 * answers a page past that window with a bare HTTP 500, so reject it up front.
 */
function checkResultWindow(page: number | undefined, size: number | undefined): void {
  if (page === undefined) return;
  const pageSize = size ?? DEFAULT_PAGE_SIZE;
  if ((page + 1) * pageSize > MAX_RESULT_WINDOW) {
    throw new AusbildungValidationError(
      `search: --page ${page} is past the API's ${MAX_RESULT_WINDOW}-result window: ` +
        `(page + 1) × size must be at most ${MAX_RESULT_WINDOW}, so with size ${pageSize} ` +
        `the last page is ${Math.floor(MAX_RESULT_WINDOW / pageSize) - 1}.`,
    );
  }
}

export function registerAusbildungCommands(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search apprenticeship/training offers")
    // Single-valued options reject a repeat (once); list-valued ones, whose API
    // parameter takes comma-separated values, accumulate repeats (commaList).
    .option("--sw <text>", "search keyword (sw); currently ignored by the API, use --ids to filter by occupation", once(parseNonEmpty))
    .option("--sty <n>", "offer type 0..3 (sty)", once(parseBoundedInt(0, 3)))
    .option("--orte <loc>", 'location as "Name_lon_lat", longitude first, e.g. "Köln_6.957_50.938" (orte); needs --uk', once(parsePlace))
    .option("--re <code>", "Bundesland code (re), e.g. BAY, NRW, THÜ; comma-separated or repeated for several", commaList(parseRegions))
    .option("--uk <radius>", 'radius around --orte: 10, 25, 50, 100 (km), or "Bundesweit" (uk); a km radius needs --orte', once(parseRadius))
    .option("--ids <id>", "occupation id(s), the dkzId from angebot.systematiken[]; comma-separated or repeated for several (ids)", commaList(parseNonEmpty))
    .option("--bart <type>", "training type (bart)", once(parseNonEmpty))
    .option("--bg", "only offers eligible for an education voucher (bg)")
    .option("--bt <date>", "start date (bt)", commaList(parseStartCodes))
    .option("--page <n>", "0-based page", once(parseIntArg))
    .option("--size <n>", "page size (1..2000; the server returns at most 20 rows)", once(parseSizeArg))
    .action(
      action(deps, async ({ client, global, opts }) => {
        checkPlaceAndRadius(opts["orte"] as string | undefined, opts["uk"] as string | undefined);
        checkResultWindow(opts["page"] as number | undefined, opts["size"] as number | undefined);
        const params: AusbildungSearchParams = {
          sw: opts["sw"] as string | undefined,
          sty: opts["sty"] as number | undefined,
          orte: opts["orte"] as string | undefined,
          re: opts["re"] as string | undefined,
          uk: opts["uk"] as string | undefined,
          ids: opts["ids"] as string | undefined,
          bart: opts["bart"] as string | undefined,
          bg: opts["bg"] as boolean | undefined,
          bt: opts["bt"] as string | undefined,
          page: opts["page"] as number | undefined,
          size: opts["size"] as number | undefined,
        };
        renderJson(deps, global, await client.search(params));
      }),
    );

  program
    .command("details")
    .description("Full details for one apprenticeship offer by id")
    .argument("<id>", "numeric offer id", parseOfferId)
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.details(id!));
      }),
    );
}
