// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO, API_KEY_ENV_VAR } from "./io.js";
import { AusbildungssucheClient } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerAusbildungCommands } from "./commands/ausbildung.js";

export const VERSION = "1.0.0";

/** Default dependencies: real client + real stdout/stderr/filesystem + process env. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new AusbildungssucheClient(options),
  env: process.env,
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  // Seed the --api-key default from the environment. Commander only applies a
  // default when the flag is absent from argv, so an explicit --api-key always
  // wins: precedence is CLI flag > env var > built-in default key. (The env is
  // read from the injected deps.env so this is unit-testable.)
  const envApiKey = deps.env[API_KEY_ENV_VAR];

  program
    .name("ausbildungssuche")
    .description(
      "CLI for the Bundesagentur für Arbeit Ausbildungssuche API " +
        "(rest.arbeitsagentur.de/infosysbub/absuche). Uses the public X-API-Key by default.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://rest.arbeitsagentur.de")
    .option(
      "--api-key <key>",
      `override the X-API-Key header (env: ${API_KEY_ENV_VAR})`,
      envApiKey,
    )
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerAusbildungCommands(program, deps);

  return program;
}
