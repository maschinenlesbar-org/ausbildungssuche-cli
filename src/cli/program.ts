// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO, API_KEY_ENV_VAR } from "./io.js";
import { AusbildungssucheClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { parseApiKey, parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg } from "./shared.js";
import { registerAusbildungCommands } from "./commands/ausbildung.js";
import { registerObtainKeyCommands } from "./commands/obtain-key.js";
import { registerConfigCommands } from "./commands/config.js";
import { CredentialStore } from "./credentials.js";
import { nodeHttpTransport } from "../client/http.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem + process env. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new AusbildungssucheClient(options),
  env: process.env,
  transport: nodeHttpTransport,
  credentials: () => CredentialStore.fromEnv(process.env),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("ausbildungssuche")
    .description(
      "CLI for the Bundesagentur für Arbeit Ausbildungssuche API " +
        "(rest.arbeitsagentur.de/infosysbub/absuche). Requires an X-API-Key: " +
        "pass --api-key, set AUSBILDUNGSSUCHE_API_KEY, or store it once with " +
        "`ausbildungssuche config set api-key` (no key is bundled).",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://rest.arbeitsagentur.de")
    .option("--api-key <key>", `X-API-Key header value (env: ${API_KEY_ENV_VAR})`, parseApiKey)
    .option(
      "--timeout <ms>",
      "time limit per request in milliseconds, whole response included (default 30000; 0 = no limit)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses (0..${MAX_RETRIES}; each waits the server's Retry-After, up to 30 s)`,
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  // Seed --api-key from AUSBILDUNGSSUCHE_API_KEY (blank treated as unset; the
  // client trims the key, as it does a --api-key or an apiKey option).
  // The env value is NOT passed as the commander option default, because commander
  // renders defaults in --help output — seeding it there would print a private key
  // verbatim in the help text. Instead set it as the option value here, which an
  // explicit --api-key on the command line overrides during parse: precedence is
  // CLI flag > env var > the credentials file (read in `action()`) > (no key). No key
  // is bundled; with none set the X-API-Key header is omitted. (The env is read from the injected deps.env so this is
  // unit-testable.)
  const envApiKey = deps.env[API_KEY_ENV_VAR];
  if (typeof envApiKey === "string" && envApiKey.trim().length > 0) {
    program.setOptionValue("apiKey", envApiKey);
  }

  registerObtainKeyCommands(program, deps);
  registerConfigCommands(program, deps);
  registerAusbildungCommands(program, deps);

  return program;
}
