import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseIntArg, renderJson } from "../shared.js";
import type { AusbildungSearchParams } from "../../client/types.js";

export function registerAusbildungCommands(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search apprenticeship/training offers")
    .option("--sw <text>", "search keyword (sw)")
    .option("--orte <id>", "location id (orte)")
    .option("--re <code>", "region / state code (re)")
    .option("--uk <radius>", 'radius: "Bundesweit" or 25..200 (km)')
    .option("--ids <id>", "profession id(s) (ids)")
    .option("--bart <type>", "training type (bart)")
    .option("--bt <date>", "start date (bt)")
    .option("--page <n>", "0-based page", parseIntArg)
    .option("--size <n>", "page size (max 2000)", parseIntArg)
    .action(
      action(deps, async ({ client, global, opts }) => {
        const params: AusbildungSearchParams = {
          sw: opts["sw"] as string | undefined,
          orte: opts["orte"] as string | undefined,
          re: opts["re"] as string | undefined,
          uk: opts["uk"] as string | undefined,
          ids: opts["ids"] as string | undefined,
          bart: opts["bart"] as string | undefined,
          bt: opts["bt"] as string | undefined,
          page: opts["page"] as number | undefined,
          size: opts["size"] as number | undefined,
        };
        renderJson(deps, global, await client.search(params));
      }),
    );

  program
    .command("details <id>")
    .description("Full details for one apprenticeship offer by id")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.details(id!));
      }),
    );
}
