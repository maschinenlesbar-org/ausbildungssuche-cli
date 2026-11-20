// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts, credentials.ts: the kit, the same in every
// repository) import the client only through this file, under the names below; the names on the
// right are this client's. Per repository, like tools.ts: a client whose names or functions differ
// adapts here.
//
// The Ausbildungssuche API needs its public X-API-Key. No key is bundled: `findCredentials` (the
// kit's hook, credentials.ts) takes it, at the first tool call, from AUSBILDUNGSSUCHE_API_KEY,
// else from the credentials file `ausbildungssuche config set api-key` writes, else obtains the
// published key with the client's obtainKey, as `ausbildungssuche obtain-key` does. Never from argv.

import { API_KEY_CREDENTIAL, CredentialStore } from "@maschinenlesbar.org/ausbildungssuche-client/internal/credentials";
import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/ausbildungssuche-client";
import { API_KEY_ENV_VAR, obtainKey } from "@maschinenlesbar.org/ausbildungssuche-client/internal/obtain-key";
import { AusbildungValidationError } from "@maschinenlesbar.org/ausbildungssuche-client/internal/errors";
import { apiKeyProblem } from "@maschinenlesbar.org/ausbildungssuche-client/internal/validate";
import type { CredentialContext, FoundCredentials } from "./credentials.js";

export {
  AusbildungssucheClient as Client,
  AusbildungError as ClientError,
  AusbildungNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/ausbildungssuche-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/ausbildungssuche-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/ausbildungssuche-client/internal/errors";

/** The service's path under the host: every endpoint is below it. */
export const SERVICE_PATH = "/infosysbub/absuche";

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the default, and the service's path). */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${SERVICE_PATH}`;
}

/**
 * The API key, in this order: AUSBILDUNGSSUCHE_API_KEY from the server's environment (what an MCP
 * client's config sets), the credentials file (`ausbildungssuche config set api-key`; only when
 * the server runs from its bin), or the public key obtained from the document that publishes it.
 * An AUSBILDUNGSSUCHE_API_KEY no header can carry, and a stored value the CLI would refuse too,
 * are errors naming the fix: never silently skipped. Every form of the key is a secret of the
 * server from here on.
 */
export async function findCredentials(context: CredentialContext): Promise<FoundCredentials> {
  const fromEnv = context.env[API_KEY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const key = fromEnv.trim();
    const problem = apiKeyProblem(key);
    if (problem !== undefined) throw new AusbildungValidationError(`Invalid ${API_KEY_ENV_VAR} in the server's environment: ${problem}`);
    return { clientOptions: { apiKey: key }, secrets: [fromEnv, key], source: `the API key from the ${API_KEY_ENV_VAR} environment variable` };
  }
  if (context.credentialsFile) {
    const store = CredentialStore.fromEnv(context.env);
    const stored = store.get(API_KEY_CREDENTIAL);
    if (stored !== undefined) {
      const problem = apiKeyProblem(stored);
      if (problem !== undefined) {
        throw new AusbildungValidationError(`The ${API_KEY_CREDENTIAL} stored in ${store.path} cannot be used: ${problem} ausbildungssuche config set ${API_KEY_CREDENTIAL} replaces it.`);
      }
      return { clientOptions: { apiKey: stored.trim() }, secrets: [stored, stored.trim()], source: `the API key stored in ${store.path} (ausbildungssuche config)` };
    }
  }
  const obtained = await obtainKey({
    transport: context.transport,
    timeoutMs: context.timeoutMs,
    userAgent: context.userAgent,
    maxResponseBytes: context.maxResponseBytes,
  });
  return {
    clientOptions: { apiKey: obtained.key },
    secrets: [obtained.key],
    source: `the public API key obtained from ${obtained.sourceUrl} (${API_KEY_ENV_VAR} is not set${context.credentialsFile ? " and no key is stored" : ""})`,
  };
}
