// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import {
  AusbildungApiError,
  AusbildungError,
  AusbildungNetworkError,
  AusbildungParseError,
  AusbildungValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";
import { API_KEY_CREDENTIAL } from "./shared.js";

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
 *   only when it reads like a number, so a key typed after `--timeout` is not;
 * - so is a rejected command argument (`details <id>`, a numeric offer id), so a key
 *   typed as the id is not — a stored key above all, which the run learns only after
 *   parsing, too late for the redaction.
 */
export function withoutStrayValues(message: string): string {
  return message
    .replace(/^(error: option '[^']*<(?:ms|n)>' argument )'([\s\S]*?)'( is invalid\.)/, (whole, head: string, value: string, tail: string) =>
      /^[\s\d.,+\-eExX]{0,24}$/.test(value) ? whole : `${head}(not shown: not a number)${tail}`,
    )
    .replace(/^(error: command-argument value )'([\s\S]*?)'( is invalid for argument )/, (whole, head: string, value: string, tail: string) =>
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
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  // The program's own (global) options; a subcommand's single-value options use once().
  if (command.parent === null) rejectRepeatedOptions(command);
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
    outputError: (str, write) => write(withoutStrayValues(str)),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `ausbildungssuche config`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. A command group
 * run without its subcommand (or the program with global options only) makes commander
 * show the help as an error (exit 1, so 2 here) with no `error:` line: an ERROR record
 * "missing command: `ausbildungssuche config <subcommand>`" comes first, so every
 * failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * The names (long and short) of the program's own options that require a value
 * (`--user-agent`). Only the program's: commander takes them out of argv wherever they
 * stand, before a subcommand sees the rest, so a subcommand's `--sw` never swallows
 * a `--log-format` after it.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
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
 * The options whose value is the base URL: a `user:password@host` given there without
 * its scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo of every URL argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: that, and every secret value replaced (`***`). */
  err(text: string): string;
  /**
   * Make `value` a secret of the run from now on (on stderr), like a flag or env value:
   * for a secret the run learns after argv, such as the key read from the credentials file.
   */
  addSecret(value: string): void;
}

/**
 * The secrets of the run in `argv` and `env`. Commander echoes a rejected value in its
 * usage errors (`option '--api-key <key>' argument '<the key>' is invalid`), and names
 * an unknown command or option as typed, so whatever path a secret takes to the
 * terminal it is replaced:
 *
 * - the userinfo of every URL argument, `--opt=value` value and of the key variable
 *   (as `credentialsIn` finds it, parseable or not: only a value with a scheme, or the
 *   `--base-url` value) becomes `***@`, on stdout and stderr;
 * - the value of `--api-key` (both forms) and the `AUSBILDUNGSSUCHE_API_KEY` value,
 *   as given and trimmed, plus their JSON-escaped forms, become `***` on stderr. Not
 *   on stdout: `obtain-key` prints the key there, and it may well be the one already
 *   in `AUSBILDUNGSSUCHE_API_KEY`. A key typed without `--api-key` is kept out of
 *   commander's messages by `withoutStrayValues`.
 *
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without secrets the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[], env: Record<string, string | undefined>): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const userinfo = new Set<string>();
  const echoed = new Set<string>();
  const passwords = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, envKey, ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) echoed.add(basic);
      if (pair !== undefined) echoed.add(pair);
      if (password !== undefined) passwords.add(password);
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
  for (const password of passwords) addKey(password);
  for (const value of flagValues(argv, SECRET_FLAGS)) addKey(value);
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const sortedKeys = (): string[] => [...keys].sort((a, b) => b.length - a.length);
  let keyList = sortedKeys();
  const echoedList = [...echoed].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactCredentials(text, urlList), echoedList);
  return {
    out,
    err: (text) => redactSecrets(out(text), keyList),
    addSecret: (value) => {
      addKey(value);
      keyList = sortedKeys();
    },
  };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv, deps.env ?? process.env);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), outRaw: deps.io.outRaw ?? out, err: (text) => err(redaction.err(text)) },
    addSecret: redaction.addSecret,
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

/**
 * True when this run supplies a key: a non-blank AUSBILDUNGSSUCHE_API_KEY, an
 * --api-key flag, or a key stored with `ausbildungssuche config set api-key`. The
 * request was already made with it, so the file reads as it did then; a file that
 * cannot be read counts as no key.
 */
function keyGiven(argv: readonly string[], deps: CliDeps): boolean {
  const envKey = deps.env[API_KEY_ENV_VAR];
  if (typeof envKey === "string" && envKey.trim() !== "") return true;
  if (argv.some((token) => token === "--api-key" || token.startsWith("--api-key="))) return true;
  try {
    return deps.credentials?.().get(API_KEY_CREDENTIAL) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`) and Node's process warnings. Its format is the one argv asks
 * for (`logFormatFromArgv`, knowing which of the program's options take a value, as `run()` reads it),
 * and it replaces the secrets of argv and `env` like the run's own log; it writes to
 * the raw stderr.
 */
export function processLogger(argv: readonly string[], env: Record<string, string | undefined> = process.env): Logger {
  return createLogger({
    format: logFormatFromArgv(argv, valueOptionsOf(buildProgram({ ...defaultDeps, env }))),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv, env).err,
  });
}

/**
 * The log area of an `AusbildungError` that is neither an API error, a network error nor
 * a usage error: a malformed answer (`api`: bad JSON, the wrong shape, an unknown
 * charset — the API's answer as much as an error status is), else `cli`.
 */
function areaOf(err: AusbildungError): string {
  if (err instanceof AusbildungParseError) return "api";
  return "cli";
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);
  // For the records of a parse error: the scan of argv, now knowing which of the program's
  // options take a value, as commander reads them.
  if (deps.log !== undefined) deps.log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  const log = deps.log;
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
  });

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
    const log = logOf(deps);
    // Client-side validation (e.g. an empty id) — a usage error, not a request.
    if (err instanceof AusbildungValidationError) {
      log.error("cli", err.message);
      return EXIT.USAGE;
    }
    if (err instanceof AusbildungApiError) {
      log.error("api", err.message);
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
        log.info(
          "api",
          keyGiven(argv, deps)
            ? "the API rejected the request (401/403). This is often — but not " +
                "always — the X-API-Key; verify the request path/params, or check " +
                "--api-key / the AUSBILDUNGSSUCHE_API_KEY env var / the stored key " +
                "(`ausbildungssuche config get api-key`)."
            : "no API key was set, and the API wants one. Get the public key with " +
                "`ausbildungssuche obtain-key` and pass it with --api-key or " +
                "AUSBILDUNGSSUCHE_API_KEY (`eval \"$(ausbildungssuche obtain-key --export)\"`), " +
                "or store it once with `ausbildungssuche obtain-key | ausbildungssuche config set api-key`.",
        );
        return EXIT.AUTH;
      }
      if (err.status === 406) {
        log.info(
          "api",
          "the API could not satisfy the Accept header (406). " +
            "The endpoint does not serve the requested media type.",
        );
        return EXIT.NOT_ACCEPTABLE;
      }
      return EXIT.OTHER;
    }
    if (err instanceof AusbildungNetworkError) {
      log.error("http", err.message);
      if (/maxResponseBytes/.test(err.message)) {
        log.info(
          "http",
          "the response exceeded the size cap. " +
            "Raise it with --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof AusbildungError) {
      log.error(areaOf(err), err.message);
      return EXIT.OTHER;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
