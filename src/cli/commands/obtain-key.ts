import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey, shellQuoteSingle } from "../../client/obtain-key.js";
import { toEngineOptions, type GlobalOptions } from "../shared.js";

/**
 * `obtain-key` — fetch the public X-API-Key and print it.
 *
 * Deliberately does NOT build a client: it must work before a key exists, which
 * is the whole point. The library's obtainKey() still applies the engine's request
 * policy, with the global --timeout, --user-agent, --max-retries and
 * --max-response-bytes forwarded. stdout carries only the key (so `$(...)` composes), while
 * the provenance note goes to stderr.
 */
export function registerObtainKeyCommands(program: Command, deps: CliDeps): void {
  program
    .command("obtain-key")
    .description(
      "Obtain the public X-API-Key this API requires and print it. The key is " +
        "the same for everyone and not a secret; it is documented by the community " +
        "project bundesAPI (github.com/bundesAPI/ausbildungssuche-api), not by the " +
        "Bundesagentur für Arbeit. None is bundled with this package, so it is read " +
        "from that README at run time.",
    )
    .option("--export", `print "export ${API_KEY_ENV_VAR}=<key>" for use with eval`)
    .action(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const global = command.optsWithGlobals() as GlobalOptions;
      // Every global request option applies except --base-url and --api-key: the
      // key source is another host, and the key does not exist yet.
      const { baseUrl: _baseUrl, apiKey: _apiKey, ...policy } = toEngineOptions(global);
      const { key, sourceUrl } = await obtainKey({
        ...policy,
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
      });
      logOf(deps).info("obtain-key", `Obtained the public key from ${sourceUrl}`);
      deps.io.out(
        command.opts()["export"] ? `export ${API_KEY_ENV_VAR}=${shellQuoteSingle(key)}` : key,
      );
    });
}

export { KEY_SOURCE_URL };
