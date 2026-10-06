// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  AusbildungApiError,
  AusbildungError,
  AusbildungNetworkError,
  AusbildungValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, an
 * auth rejection, a missing resource, a content-negotiation failure, a transport
 * failure, and a catch-all runtime error.
 */
const EXIT = {
  /** Usage / parse / client-side validation error. */
  USAGE: 2,
  /** 401/403 — the API key was rejected. */
  AUTH: 3,
  /** 404 — resource not found. */
  NOT_FOUND: 4,
  /** 406 — Accept negotiation failed. */
  NOT_ACCEPTABLE: 5,
  /** Network / transport failure (DNS, connection, timeout, size-cap). */
  NETWORK: 6,
  /** Any other error. */
  OTHER: 1,
} as const;

/**
 * Commander's usage errors repeat what the user typed. Where that may be a key
 * typed in the wrong place (`ausbildungssuche my-key search`, `details 123 my-key`),
 * say what went wrong without the value:
 *
 * - `too many arguments for 'x'. Expected 1 argument but got 2: <values>.` loses
 *   the values;
 * - `unknown option '--apikey=<value>'` keeps the option name, not the value;
 * - `unknown command '<value>'` shows the value only when it reads like a command
 *   name (lower-case letters and hyphens), so a key typed without `--api-key` is not
 *   echoed while a typo such as `serach` still is;
 * - a rejected value of a numeric option (`--timeout <ms>`, `--size <n>`, …) is shown
 *   only when it reads like a number, so a key typed after `--timeout` is not.
 */
export function withoutStrayValues(message: string): string {
  return message
    .replace(/^(error: option '[^']*<(?:ms|n)>' argument )'([\s\S]*?)'( is invalid\.)/, (whole, head: string, value: string, tail: string) =>
      /^[\s\d.,+\-eExX]{0,24}$/.test(value) ? whole : `${head}(not shown: not a number)${tail}`,
    )
    .replace(/^(error: too many arguments for '[^']*'\. Expected \d+ arguments? but got \d+): [\s\S]*?\.(\n|$)/, "$1.$2")
    .replace(/^(error: unknown option '-[^=']*=)[\s\S]*?'(\n|$)/, "$1…'$2")
    .replace(/^error: unknown command '([\s\S]*?)'(\n|$)/, (whole, value: string, end: string) =>
      /^[a-z][a-z-]{0,39}$/.test(value) ? whole : `error: unknown command (not shown: it is not a command name)${end}`,
    );
}

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  // The program's own (global) options; a subcommand's single-value options use once().
  if (command.parent === null) rejectRepeatedOptions(command);
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
    outputError: (str, write) => write(withoutStrayValues(str)),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Make a repeated global option a usage error (P10). Commander keeps the last value of
 * `--api-key A --api-key B` or `--base-url A --base-url B` without a word, so a script
 * that builds its argv from two sources silently gets one of them. Every value option
 * of `command` counts its occurrences (commander emits `option:<name>` once per
 * occurrence; a default or an env-seeded key emits none) and the second one throws —
 * naming the option, never the value.
 */
function rejectRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if (!(option.required || option.optional) || option.variadic) continue;
    let seen = 0;
    command.on(`option:${option.name()}`, () => {
      seen += 1;
      if (seen > 1) {
        throw new AusbildungValidationError(`option '${option.flags}' was given more than once; it takes one value.`);
      }
    });
  }
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--api-key"];

/**
 * `deps` with an `io` that keeps the secrets of this run out of everything it
 * prints. Commander echoes a rejected value in its usage errors (`option '--api-key
 * <key>' argument '<the key>' is invalid`), and names an unknown command or option as
 * typed, so whatever path a secret takes to the terminal it is replaced:
 *
 * - the userinfo of every URL-like argument, `--opt=value` value and of the key
 *   variable (as `credentialsIn` finds it, parseable or not) becomes `***@`, on stdout
 *   and stderr;
 * - the value of `--api-key` (both forms) and the `AUSBILDUNGSSUCHE_API_KEY` value,
 *   as given and trimmed, plus their JSON-escaped forms, become `***` on stderr. Not
 *   on stdout: `obtain-key` prints the key there, and it may well be the one already
 *   in `AUSBILDUNGSSUCHE_API_KEY`. A key typed without `--api-key` is kept out of
 *   commander's messages by `withoutStrayValues`.
 *
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without secrets the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const env = deps.env ?? process.env;
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const userinfo = new Set<string>();
  for (const source of [...argv, ...values, envKey]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  const keys = new Set<string>();
  const addKey = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const form of [value, value.trim()]) {
      keys.add(form);
      keys.add(JSON.stringify(form).slice(1, -1));
    }
  };
  addKey(envKey);
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token)) addKey(argv[i + 1]);
    const eq = token.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.includes(token.slice(0, eq))) addKey(token.slice(eq + 1));
  });
  if (userinfo.size === 0 && [...keys].every((k) => k.trim().length < 4)) return deps;
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const keyList = [...keys].sort((a, b) => b.length - a.length);
  const redactOut = (text: string): string => redactCredentials(text, urlList);
  const redactErr = (text: string): string => redactSecrets(redactOut(text), keyList);
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redactOut(text)), err: (text) => deps.io.err(redactErr(text)) },
  };
}

/** True when this run supplies a key: a non-blank AUSBILDUNGSSUCHE_API_KEY or an --api-key flag. */
function keyGiven(argv: readonly string[], deps: CliDeps): boolean {
  const envKey = deps.env[API_KEY_ENV_VAR];
  if (typeof envKey === "string" && envKey.trim() !== "") return true;
  return argv.some((token) => token === "--api-key" || token.startsWith("--api-key="));
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help` (commander's default routes the
  // "missing command" help to stderr with a non-zero code, which breaks
  // `... | less` and is inconsistent with --help).
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; map every genuine usage/parse error to a
      // single distinct USAGE code so scripts can tell it apart from a network
      // or HTTP error (commander's own exitCode is 1, indistinguishable from
      // the catch-all). exitCode 0 (help/version) is preserved.
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    // Client-side validation (e.g. an empty id) — a usage error, not a request.
    if (err instanceof AusbildungValidationError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.USAGE;
    }
    if (err instanceof AusbildungApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map a few notable statuses to distinct exit codes for scripting, and
      // nudge the user toward the likely cause for the auth/negotiation ones.
      if (err.status === 404) return EXIT.NOT_FOUND;
      // When a redirect to another origin dropped the key, the message already says so
      // (an http: base URL redirected to https: is the usual case): the API never saw
      // the key, so this is not a verdict on it — no key hint, and not exit 3.
      if ((err.status === 401 || err.status === 403) && err.credentialsDropped !== undefined) {
        return EXIT.OTHER;
      }
      if (err.status === 401 || err.status === 403) {
        // A 403 is not always an auth failure (e.g. a malformed request path can
        // 403 with the valid public key). Without any key the cause is plain, so say
        // so; with one, point at the key and the request alike.
        deps.io.err(
          keyGiven(argv, deps)
            ? "Hint: the API rejected the request (401/403). This is often — but not " +
                "always — the X-API-Key; verify the request path/params, or check " +
                "--api-key / the AUSBILDUNGSSUCHE_API_KEY env var."
            : "Hint: no API key was set, and the API wants one. Get the public key with " +
                "`ausbildungssuche obtain-key` and pass it with --api-key or " +
                "AUSBILDUNGSSUCHE_API_KEY (`eval \"$(ausbildungssuche obtain-key --export)\"`).",
        );
        return EXIT.AUTH;
      }
      if (err.status === 406) {
        deps.io.err(
          "Hint: the API could not satisfy the Accept header (406). " +
            "The endpoint does not serve the requested media type.",
        );
        return EXIT.NOT_ACCEPTABLE;
      }
      return EXIT.OTHER;
    }
    if (err instanceof AusbildungNetworkError) {
      deps.io.err(`Error: ${err.message}`);
      if (/maxResponseBytes/.test(err.message)) {
        deps.io.err(
          "Hint: the response exceeded the size cap. " +
            "Raise it with --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof AusbildungError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.OTHER;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
