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
} from "../client/errors.js";

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
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
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
      if (err.status === 401 || err.status === 403) {
        // A 403 is not always an auth failure (e.g. a malformed request path can
        // 403 with the valid public key). Only mention the key for 401, or for a
        // 403 when a non-default key is in play; otherwise point at the request.
        deps.io.err(
          "Hint: the API rejected the request (401/403). This is often — but not " +
            "always — the X-API-Key; verify the request path/params, or check " +
            "--api-key / the AUSBILDUNGSSUCHE_API_KEY env var.",
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
