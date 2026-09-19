import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseIntArg, parseNonEmpty, parseSizeArg, renderJson } from "../shared.js";
import type { AusbildungSearchParams } from "../../client/types.js";

export function registerAusbildungCommands(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search apprenticeship/training offers")
    .option("--sw <text>", "search keyword (sw); currently ignored by the API, use --ids to filter by occupation", parseNonEmpty)
    .option("--sty <n>", "offer type 0..3 (sty); 4 is rejected with HTTP 400", parseIntArg)
    .option("--orte <loc>", 'location as "Name_lon_lat", longitude first, e.g. "Köln_6.957_50.938" (orte)', parseNonEmpty)
    .option("--re <code>", "Bundesland code (re), e.g. BAY, NRW, THÜ; comma-separated for several", parseNonEmpty)
    .option("--uk <radius>", 'radius: "Bundesweit" or 10, 25, 50, 100 (km)', parseNonEmpty)
    .option("--ids <id>", "occupation id(s), the dkzId from angebot.systematiken[]; comma-separated for several (ids)", parseNonEmpty)
    .option("--bart <type>", "training type (bart)", parseNonEmpty)
    .option("--bg", "only offers eligible for an education voucher (bg)")
    .option("--bt <date>", "start date (bt)", parseNonEmpty)
    .option("--page <n>", "0-based page", parseIntArg)
    .option("--size <n>", "page size (1..2000; the server returns at most 20 rows)", parseSizeArg)
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
        renderJson(deps, global, await client.search(params));
      }),
    );

  program
    .command("details")
    .description("Full details for one apprenticeship offer by id")
    .argument("<id>", "offer id", parseNonEmpty)
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.details(id!));
      }),
    );
}
