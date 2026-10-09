// `ausbildungssuche config` and the credentials file: the API key kept apart from argv
// and the environment, the same mechanism as openka-cli's `ka config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { run } from "../src/cli/run.js";
import { AusbildungssucheClient } from "../src/client/client.js";
import { AusbildungError } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import { readSecretFrom } from "../src/cli/io.js";
import { CredentialStore, maskCredential, resolveCredentialsPath } from "../src/cli/credentials.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, okResponse, rawResponse, untimed } from "./helpers.js";

const KEY = "fake-test-key-0123456789abcdef";
const MASKED = "fake…cdef";

/** A CLI whose credentials file lives in a temporary directory, and whose secret prompt answers `secret`. */
function makeCli(
  options: {
    env?: Record<string, string | undefined>;
    secret?: string;
    credentials?: boolean;
    responder?: (req: HttpRequest) => HttpResponse;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ausbildungssuche-config-"));
  const store = new CredentialStore(join(dir, "ausbildungssuche", "credentials"));
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(options.responder ?? okResponse);
  let storeReads = 0;
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      ...(options.secret === undefined ? {} : { readSecret: async () => options.secret as string }),
    },
    createClient: (opts) => new AusbildungssucheClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    transport: mt.transport,
    ...(options.credentials === false
      ? {}
      : {
          credentials: () => {
            storeReads += 1;
            return store;
          },
        }),
  };
  return {
    deps,
    out,
    err,
    mt,
    store,
    dir,
    storeReads: () => storeReads,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("config set stores the key from the prompt, mode 0600 in a 0700 directory, and shows it masked", async () => {
  const cli = makeCli({ secret: `${KEY}\n` });
  try {
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), KEY);
    assert.equal(statSync(cli.store.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(cli.dir, "ausbildungssuche")).mode & 0o777, 0o700);
    assert.match(untimed(cli.err.join("\n")), new RegExp(`^INFO  \\[ausbildungssuche\\.config\\] Stored api-key \\(${MASKED}\\) in `));
    assert.ok(!(cli.err.join("\n") + cli.out.join("\n")).includes(KEY));

    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 0);
    assert.deepEqual(cli.out, [MASKED]);
    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key", "--reveal"], cli.deps), 0);
    assert.deepEqual(cli.out, [KEY]);
    cli.out.length = 0;
    cli.err.length = 0;
    assert.equal(await run(["config", "list"], cli.deps), 0);
    assert.deepEqual(cli.out, [`api-key  ${MASKED}`]);
    assert.match(cli.err.join("\n"), new RegExp(`Credentials file: ${cli.store.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("config set never takes the value from the command line, and never repeats it", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    assert.equal(await run(["config", "set", "api-key", KEY], cli.deps), 2);
    assert.match(cli.err.join("\n"), /takes the name only/);
    assert.ok(!cli.err.join("\n").includes(KEY));
    assert.ok(!cli.out.join("\n").includes(KEY));
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "set", "password"], cli.deps), 2, "an unknown name");
  } finally {
    cli.cleanup();
  }
});

test("config set refuses a blank value or one with whitespace inside, and stores nothing", async () => {
  for (const secret of ["", "   ", "\n", "two words"]) {
    const cli = makeCli({ secret });
    try {
      assert.equal(await run(["config", "set", "api-key"], cli.deps), 2, JSON.stringify(secret));
      assert.match(cli.err.join("\n"), /Nothing was stored/);
      assert.equal(cli.store.get("api-key"), undefined);
    } finally {
      cli.cleanup();
    }
  }
});

test("config set without a way to read a secret refuses, and stores nothing", async () => {
  const cli = makeCli();
  try {
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 2);
    assert.match(cli.err.join("\n"), /No way to read a secret/);
    assert.equal(cli.store.get("api-key"), undefined);
  } finally {
    cli.cleanup();
  }
});

test("the stored key is sent when neither --api-key nor AUSBILDUNGSSUCHE_API_KEY gives one, and only then", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    await run(["config", "set", "api-key"], cli.deps);
    assert.equal(await run(["search", "--sw", "x"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], KEY);

    // The env var and the flag come first, and the file is not read for them.
    const fromEnv = makeCli({ env: { AUSBILDUNGSSUCHE_API_KEY: "env-key-1234" } });
    let reads = 0;
    const viaEnv: CliDeps = {
      ...fromEnv.deps,
      credentials: () => {
        reads += 1;
        return cli.store;
      },
    };
    assert.equal(await run(["search", "--sw", "x"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["X-API-Key"], "env-key-1234");
    assert.equal(await run(["--api-key", "flag-key-1234", "search", "--sw", "x"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["X-API-Key"], "flag-key-1234");
    assert.equal(reads, 0);
    fromEnv.cleanup();
  } finally {
    cli.cleanup();
  }
});

test("a credentials file others can read is refused, and only when it is needed", async () => {
  const cli = makeCli();
  try {
    cli.store.set("api-key", KEY);
    chmodSync(cli.store.path, 0o644);
    assert.equal(await run(["search", "--sw", "x"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /can be read by others \(mode 644\).*chmod 600/);
    assert.equal(cli.mt.calls.length, 0);
    // A key given another way does not read the file at all.
    assert.equal(await run(["--api-key", "flag-key-1234", "search", "--sw", "x"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], "flag-key-1234");
  } finally {
    cli.cleanup();
  }
});

test("obtain-key does not read the credentials file", async () => {
  const cli = makeCli({
    responder: () => rawResponse('curl -H "X-API-Key: infosysbub-absuche" https://rest.arbeitsagentur.de/', "text/plain"),
  });
  try {
    assert.equal(await run(["obtain-key"], cli.deps), 0);
    assert.deepEqual(cli.out, ["infosysbub-absuche"]);
    assert.equal(cli.storeReads(), 0);
  } finally {
    cli.cleanup();
  }
});

test("a rejected stored key gets the key hint, which names config", async () => {
  const cli = makeCli({ responder: () => jsonResponse({}, 401) });
  try {
    cli.store.set("api-key", KEY);
    assert.equal(await run(["search", "--sw", "x"], cli.deps), 3);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], KEY);
    assert.match(cli.err.join("\n"), /ausbildungssuche config get api-key/);
    assert.ok(!cli.err.join("\n").includes(KEY));
  } finally {
    cli.cleanup();
  }
  const none = makeCli({ responder: () => jsonResponse({}, 401) });
  try {
    assert.equal(await run(["search", "--sw", "x"], none.deps), 3);
    assert.match(none.err.join("\n"), /no API key was set.*ausbildungssuche config set api-key/s);
  } finally {
    none.cleanup();
  }
});

test("deps without a credentials store never read a credentials file", async () => {
  const cli = makeCli({ credentials: false, env: { XDG_CONFIG_HOME: "/nonexistent" } });
  try {
    assert.equal(await run(["search", "--sw", "x"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
    assert.equal(await run(["config", "list"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /without a credentials file/);
  } finally {
    cli.cleanup();
  }
});

test("the credentials file: where it is, what it refuses, and how it masks", () => {
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "/x" }), "/x/ausbildungssuche/credentials");
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "relative", HOME: "/home/me" }), "/home/me/.config/ausbildungssuche/credentials");
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: " ", HOME: "/home/me" }), "/home/me/.config/ausbildungssuche/credentials");
  assert.equal(maskCredential("short"), "****");
  assert.equal(maskCredential(KEY), MASKED);
  const dir = mkdtempSync(join(tmpdir(), "ausbildungssuche-store-"));
  try {
    const path = join(dir, "credentials");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ "api-key": 5 }), { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not an object of names and strings/);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "credentials"), JSON.stringify({ "api-key": KEY }), { mode: 0o600 });
    symlinkSync(join(dir, "real", "credentials"), join(dir, "link"));
    assert.throws(() => new CredentialStore(join(dir, "link")).get("api-key"), /not a regular file/);
    const store = new CredentialStore(join(dir, "fresh", "credentials"));
    store.set("api-key", KEY);
    assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), { "api-key": KEY });
    assert.throws(() => store.set("API KEY", KEY), /Not a credential name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret piped in is read whole, one trailing newline dropped", async () => {
  assert.equal(await readSecretFrom(Readable.from([`${KEY}\n`]), { write: () => true }, "api-key: "), KEY);
  assert.equal(await readSecretFrom(Readable.from([Buffer.from("ab"), Buffer.from(`c\r\n`)]), { write: () => true }, "api-key: "), "abc");
});

test("an unwritable config location names the credentials file, for set and for the last unset (C4)", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
  const cli = makeCli({ secret: KEY });
  try {
    // The parent of the program's directory cannot be written: mkdir fails.
    const parent = join(cli.dir, "ausbildungssuche");
    mkdirSync(cli.dir, { recursive: true });
    chmodSync(cli.dir, 0o500);
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(cli.dir, 0o700);

    // The last name removed from a file in a directory that cannot be written: rm fails.
    cli.err.length = 0;
    cli.store.set("api-key", KEY);
    chmodSync(parent, 0o500);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(parent, 0o700);
    assert.equal(cli.store.get("api-key"), KEY, "nothing was lost");
  } finally {
    chmodSync(cli.dir, 0o700);
    cli.cleanup();
  }
});

test("maskCredential: a key shows its ends only from 20 characters, a password never (C7)", () => {
  assert.equal(maskCredential("Somm3r2026!x"), "****");
  assert.equal(maskCredential("a".repeat(19)), "****");
  assert.equal(maskCredential("infosysbub-absuche", "api-key"), "****", "the published key is 18 characters");
  assert.equal(maskCredential("abcd0123456789ab wxyz".replace(" ", "")), "abcd…wxyz");
  assert.equal(maskCredential(KEY, "api-key"), MASKED);
  assert.equal(maskCredential("a-very-long-password-of-40-characters!!!", "password"), "****");
});

test("a key typed in place of the name is never echoed, by any config command (C2)", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    const typed = "abcSECRET-personal-key-123";
    for (const argv of [
      ["config", "set", typed],
      ["config", "get", typed],
      ["config", "get", typed, "--reveal"],
      ["config", "unset", typed],
      ["config", "get", "api-key", typed],
      ["config", "unset", "api-key", typed],
      ["config", "list", typed],
      ["--log-format", "jsonl", "config", "set", typed],
    ]) {
      cli.err.length = 0;
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      const err = cli.err.join("\n");
      assert.ok(!err.includes("SECRET"), `${argv.join(" ")}:\n${err}`);
      assert.match(err, /ERROR.*ausbildungssuche\.cli/, argv.join(" "));
    }
    cli.err.length = 0;
    assert.equal(await run(["config", "get", typed], cli.deps), 2);
    assert.match(cli.err.join("\n"), /Not a credential name this program knows: expected api-key\./);
  } finally {
    cli.cleanup();
  }
});

test("a secret read from stdin stops at 64 KiB and is refused, an endless input included (C3)", async () => {
  await assert.rejects(readSecretFrom(Readable.from([Buffer.alloc(70 * 1024, "a")]), { write: () => true }, "api-key: "), /longer than 64 KiB; nothing was stored/);
  let chunks = 0;
  async function* zero() {
    for (;;) {
      chunks++;
      yield Buffer.alloc(16 * 1024);
    }
  }
  await assert.rejects(readSecretFrom(Readable.from(zero()), { write: () => true }, "api-key: "), /longer than 64 KiB/);
  assert.ok(chunks < 10, `read ${chunks} chunks`);
  const exact = "a".repeat(64 * 1024);
  assert.equal(await readSecretFrom(Readable.from([exact + "\n"]), { write: () => true }, "api-key: "), exact);
});

/** A terminal as far as readSecretFrom needs one: raw mode, data events. */
class FakeTty extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  setRawMode(on: boolean): this {
    this.raw = on;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

/** What the prompt returns for keystrokes arriving in `reads` (one data event each). */
async function typed(...reads: string[]): Promise<string> {
  const tty = new FakeTty();
  const result = readSecretFrom(tty as unknown as NodeJS.ReadStream, { write: () => true }, "api-key: ");
  for (const read of reads) tty.emit("data", Buffer.from(read));
  return result;
}

test("the prompt drops escape sequences and keeps what was typed (C1)", async () => {
  assert.equal(await typed("abc\u001b[A\u001b[Ddef\r"), "abcdef", "arrow keys");
  assert.equal(await typed("\u001bOAabc\r"), "abc", "SS3");
  assert.equal(await typed("\u001b[200~infosysbub-absuche\u001b[201~\r"), "infosysbub-absuche", "bracketed paste");
  assert.equal(await typed("\u001b[1;5Cabc\r"), "abc", "a CSI with parameters");
  assert.equal(await typed("abc\u001b", "[Adef\r"), "abcdef", "a sequence split across reads");
  assert.equal(await typed("arrow-key-1234\u001b[D5\r"), "arrow-key-12345", "the report's arrow key");
  assert.equal(await typed("abcd\u007f\r"), "abc", "Backspace");
  assert.equal(await typed("key\r\n"), "key", "CR LF is one line break");
  // A tab is kept, so config set refuses it like the same value from a pipe.
  assert.equal(await typed("abc\tdef\r"), "abc\tdef");
  await assert.rejects(typed("abc\u0003"), /Interrupted; nothing was stored/);
});

test("the prompt refuses a paste with more after its first line break (C1)", async () => {
  for (const read of ["key\nsecondline\n", "key\rsecondline\r", "key\r\nmore", "first-half-1234\nsecond-half-5678\r"]) {
    await assert.rejects(typed(read), /The value holds a line break; nothing was stored\./, JSON.stringify(read));
  }
});

test("set and unset take credentials.lock: a held lock fails after 2 s, a stale one is taken over (C8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ausbildungssuche-lock-"));
  try {
    let clock = 1_000_000;
    const waits: number[] = [];
    const options = { now: () => clock, sleep: (ms: number) => { waits.push(ms); clock += ms; } };
    const path = join(dir, "ausbildungssuche", "credentials");
    const store = new CredentialStore(path, options);
    store.set("api-key", KEY);
    assert.equal(existsSync(`${path}.lock`), false, "the lock is released");

    // Another writer holds the lock: retried for 2 s, then refused, nothing changed.
    writeFileSync(`${path}.lock`, "4242");
    utimesSync(`${path}.lock`, clock / 1000, clock / 1000);
    assert.throws(() => store.set("api-key", "other-key-abcdefghijklmnopqrstuvwxyz"), /Another ausbildungssuche config is writing .*credentials; try again\./);
    assert.ok(waits.length > 1 && waits.reduce((a, b) => a + b, 0) >= 2000, `waited ${waits.join(",")}`);
    assert.throws(() => store.unset("api-key"), /Another ausbildungssuche config is writing/);
    assert.equal(store.get("api-key"), KEY);

    // A lock older than 30 s is left over from a crash: taken over.
    clock += 31_000;
    store.set("api-key", "other-key-abcdefghijklmnopqrstuvwxyz");
    assert.equal(store.get("api-key"), "other-key-abcdefghijklmnopqrstuvwxyz");
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held lock fails config set with exit 1 and the stored value kept (C8)", async () => {
  const cli = makeCli({ secret: "other-key-abcdefghijklmnopqrstuvwxyz" });
  try {
    cli.store.set("api-key", KEY);
    writeFileSync(`${cli.store.path}.lock`, "4242");
    const store = new CredentialStore(cli.store.path, { sleep: () => undefined, now: (() => { let t = Date.now(); return () => (t += 500); })() });
    assert.equal(await run(["config", "set", "api-key"], { ...cli.deps, credentials: () => store }), 1);
    assert.match(cli.err.join("\n"), /ERROR \[ausbildungssuche\.cli\] Another ausbildungssuche config is writing/);
    assert.equal(cli.store.get("api-key"), KEY);
  } finally {
    cli.cleanup();
  }
});

test("the stored key is a secret of the run the moment it is read: no record shows it (C5)", async () => {
  const personal = "personal-key-of-another-shape-0123";
  const cli = makeCli();
  try {
    cli.store.set("api-key", personal);
    for (const format of ["text", "jsonl"]) {
      cli.err.length = 0;
      // Whatever path the key takes to a message — here a client that quotes it.
      const deps: CliDeps = { ...cli.deps, createClient: (opts) => { throw new AusbildungError(`could not use ${String(opts.apiKey)}`); } };
      assert.equal(await run(["--log-format", format, "search"], deps), 1);
      assert.match(cli.err.join("\n"), /could not use \*\*\*/, format);
      assert.ok(!cli.err.join("\n").includes("personal-key"), `${format}: ${cli.err.join("\n")}`);
    }
  } finally {
    cli.cleanup();
  }
});

test("the stored key typed as the details id is not echoed, as the same key from the env var is not (02 Bug 1)", async () => {
  const stored = "stored-key-ABCDEF123";
  const cli = makeCli();
  try {
    cli.store.set("api-key", stored);
    for (const format of ["text", "jsonl"]) {
      cli.err.length = 0;
      assert.equal(await run(["--log-format", format, "details", stored], cli.deps), 2);
      const all = cli.err.join("\n");
      assert.match(all, /command-argument value \(not shown: not a number\) is invalid for argument 'id'/, `${format}: ${all}`);
      assert.ok(!all.includes("ABCDEF"), `${format}: ${all}`);
    }
    // A number-like id is still shown, so a typo can be seen.
    cli.err.length = 0;
    assert.equal(await run(["details", "-1"], cli.deps), 2);
    assert.equal(await run(["details", "1.5"], cli.deps), 2);
    assert.match(cli.err.join("\n"), /command-argument value '1\.5' is invalid for argument 'id'/);
  } finally {
    cli.cleanup();
  }
});
