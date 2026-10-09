import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import {
  action,
  commaList,
  once,
  parseBoundedInt,
  parseIds,
  parseIntArg,
  parseNonEmpty,
  parseOfferId,
  parsePlace,
  parseRadius,
  parseRegions,
  parseSizeArg,
  parseStartCodes,
  parseTrainingType,
  renderJson,
} from "../shared.js";
import type { AusbildungSearchParams } from "../../client/types.js";
import { AusbildungValidationError } from "../../client/errors.js";
import { MAX_PAGE_SIZE, placeAndRadiusProblem, STY_MAX, STY_MIN } from "../../client/validate.js";

export function registerAusbildungCommands(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search apprenticeship/training offers")
    // Single-valued options reject a repeat (once); list-valued ones, whose API
    // parameter takes comma-separated values, accumulate repeats (commaList).
    .option("--sw <text>", "search keyword (sw); currently ignored by the API, use --ids to filter by occupation", once(parseNonEmpty))
    .option("--sty <n>", `offer type ${STY_MIN}..${STY_MAX} (sty)`, once(parseBoundedInt(STY_MIN, STY_MAX)))
    .option("--orte <loc>", 'location as "Name_lon_lat", longitude first, e.g. "Köln_6.957_50.938", or several comma-separated (orte); needs --uk', once(parsePlace))
    .option("--re <code>", "Bundesland code (re), e.g. BAY, NRW, THÜ; comma-separated or repeated for several", commaList(parseRegions))
    .option("--uk <radius>", 'radius around --orte: 10, 25, 50, 100 (km), or "Bundesweit" (uk); a km radius needs --orte', once(parseRadius))
    .option("--ids <id>", "numeric occupation id(s), the dkzId from angebot.systematiken[]; comma-separated or repeated for several (ids)", commaList(parseIds))
    .option("--bart <type>", "numeric training type, the bildungsart.id, e.g. 102 Berufsausbildung (bart)", once(parseTrainingType))
    .option("--bg", "only offers eligible for an education voucher (bg)")
    .option("--bt <code>", "start-date code(s) (bt): 2 = earlier dates, 101..112 = January..December of the following year; 0 and 1 filter too, meaning undocumented; not a date. Comma-separated or repeated for several", commaList(parseStartCodes))
    .option("--page <n>", "0-based page", once(parseIntArg))
    .option("--size <n>", `page size, 1..${MAX_PAGE_SIZE} (the server serves at most ${MAX_PAGE_SIZE} rows per page)`, once(parseSizeArg))
    .action(
      action(deps, async ({ client, global, opts }) => {
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
        // The library rejects the same pairing; checking it here first keeps the
        // message in flag terms (--orte/--uk).
        const pairing = placeAndRadiusProblem(params, (p) => `--${p}`);
        if (pairing !== undefined) throw new AusbildungValidationError(`search: ${pairing}`);
        const result = await client.search(params);
        renderJson(deps, global, result);
        // The API answers an id or training type it doesn't know with an empty result,
        // not an error, so say which filter may be the reason (stderr; stdout stays JSON).
        const named = (["ids", "bart"] as const).filter((p) => params[p] !== undefined);
        if (result.page?.totalElements === 0 && named.length > 0) {
          logOf(deps).info(
            "api",
            `no offers matched. The API answers an unknown ${named.map((p) => `--${p}`).join(" or ")} ` +
              "value with an empty result, not an error; check the value.",
          );
        }
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
