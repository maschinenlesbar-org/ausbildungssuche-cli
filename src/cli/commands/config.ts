// `ausbildungssuche config` — the API key kept in a credentials file of its own, the same
// mechanism as openka-cli's `ka config`. A key goes in through a prompt without echo
// or through stdin, never as an argument, so it reaches neither shell history nor
// `ps`; it comes out masked unless asked for in full.

import type { Command } from "commander";
import { AusbildungError, AusbildungValidationError } from "../../client/errors.js";
import { apiKeyProblem } from "../../client/validate.js";
import { CONFIG_DIR_NAME, credentialValueProblem, maskCredential, type CredentialStore } from "../credentials.js";
import { logOf, type CliDeps } from "../io.js";
import { API_KEY_CREDENTIAL } from "../shared.js";

/** The credentials this program knows. */
export const CREDENTIAL_NAMES = [API_KEY_CREDENTIAL] as const;

/**
 * The credential name a config command was given, checked in the action rather than by
 * a commander argument parser: commander repeats a rejected argument (`argument
 * 'abcSECRET…' is invalid`) and every surplus one (`too many arguments … got 2: …`), and
 * a key typed in place of the name would end up in the log. The usage errors here name
 * the valid names, never what was typed.
 */
function credentialNameArg(command: Command, usage: string): string {
  const [name, ...rest] = command.args;
  if (rest.length > 0) throw new AusbildungValidationError(`${usage} takes one name: ${CREDENTIAL_NAMES.join(", ")}.`);
  if (name === undefined || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) {
    throw new AusbildungValidationError(`Not a credential name this program knows: expected ${CREDENTIAL_NAMES.join(", ")}.`);
  }
  return name;
}

/** Why `value` cannot be stored under `name`, or undefined. */
function valueProblem(name: string, value: string): string | undefined {
  return credentialValueProblem(value) ?? (name === API_KEY_CREDENTIAL ? apiKeyProblem(value) : undefined);
}

function storeOf(deps: CliDeps): CredentialStore {
  if (deps.credentials === undefined) throw new AusbildungError("This program was built without a credentials file.");
  return deps.credentials();
}

export function registerConfigCommands(program: Command, deps: CliDeps): void {
  const names = CREDENTIAL_NAMES.join(", ");
  const config = program
    .command("config")
    .description(`the API key, kept in a credentials file of its own: $XDG_CONFIG_HOME/${CONFIG_DIR_NAME}/credentials, else ~/.config/${CONFIG_DIR_NAME}/credentials (${names})`);

  config
    .command("set")
    .description("store a credential: typed at a prompt without echo, or piped in (ausbildungssuche obtain-key | ausbildungssuche config set api-key) — never given as an argument")
    .argument("<name>", names)
    // Commander's own "too many arguments" error repeats them — here, the secret.
    .allowExcessArguments(true)
    .action(async (_name: string, _options: unknown, command: Command) => {
      if (command.args.length > 1) {
        throw new AusbildungValidationError(
          "ausbildungssuche config set takes the name only: the value is read from a prompt or from stdin, never from the command line. " +
            "The one given is now in your shell history; if it is a secret, replace it there.",
        );
      }
      // The global --api-key is not read here either: a user who knows it will try
      // `config set api-key --api-key KEY`, which used to store stdin without a word.
      if (command.optsWithGlobals<{ apiKey?: string }>().apiKey !== undefined && command.getOptionValueSourceWithGlobals("apiKey") === "cli") {
        throw new AusbildungValidationError(
          "ausbildungssuche config set takes the name only: the value is read from a prompt or from stdin, never from the command line, " +
            "and --api-key is not read here. The one given is now in your shell history; if it is a secret, replace it there.",
        );
      }
      const name = credentialNameArg(command, "ausbildungssuche config set");
      if (deps.io.readSecret === undefined) throw new AusbildungValidationError("No way to read a secret here: pipe it in, or run ausbildungssuche config set on a terminal.");
      const value = (await deps.io.readSecret(`${name}: `)).trim();
      deps.addSecret?.(value);
      const reason = valueProblem(name, value);
      if (reason !== undefined) throw new AusbildungValidationError(`${reason} Nothing was stored.`);
      const store = storeOf(deps);
      store.set(name, value);
      logOf(deps).info("config", `Stored ${name} (${maskCredential(value, name)}) in ${store.path}.`);
    });

  config
    .command("get")
    .description("show a stored credential, masked (abcd…wxyz, or **** below 20 characters) unless --reveal")
    .argument("<name>", names)
    .allowExcessArguments(true)
    .option("--reveal", "print the whole value, for a script that passes it on — it then is on your screen or in its log")
    .action(async (_name: string, options: { reveal?: boolean }, command: Command) => {
      const name = credentialNameArg(command, "ausbildungssuche config get");
      const store = storeOf(deps);
      const value = store.get(name);
      if (value === undefined) throw new AusbildungError(`No ${name} is stored in ${store.path}; ausbildungssuche config set ${name} stores one.`);
      deps.addSecret?.(value);
      // --reveal prints the value as stored: the run's redaction (a credential from a flag
      // that happens to occur in it) would hand a script a wrong value with exit 0.
      if (options.reveal === true) (deps.io.outRaw ?? deps.io.out)(value);
      else deps.io.out(maskCredential(value, name));
    });

  config
    .command("unset")
    .description("remove a stored credential")
    .argument("<name>", names)
    .allowExcessArguments(true)
    .action(async (_name: string, _options: unknown, command: Command) => {
      const name = credentialNameArg(command, "ausbildungssuche config unset");
      const store = storeOf(deps);
      if (!store.unset(name)) throw new AusbildungError(`No ${name} is stored in ${store.path}.`);
      logOf(deps).info("config", `Removed ${name} from ${store.path}.`);
    });

  config
    .command("list")
    .description("every stored credential, masked, and where the file is")
    .allowExcessArguments(true)
    .action(async (_options: unknown, command: Command) => {
      if (command.args.length > 0) throw new AusbildungValidationError("ausbildungssuche config list takes no arguments.");
      const store = storeOf(deps);
      for (const name of store.names()) deps.io.out(`${name}  ${maskCredential(store.get(name) as string, name)}`);
      logOf(deps).info("config", `Credentials file: ${store.path}`);
    });
}
