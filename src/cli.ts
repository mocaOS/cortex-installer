#!/usr/bin/env node
import * as p from "@clack/prompts";
import { installerVersion } from "./version.js";
import { parseArgs, HELP } from "./args.js";

/**
 * This file is the bin entry point and NOTHING else — no exports, no
 * conditional "am I the main module?" guard.
 *
 * It used to guard on `process.argv[1].endsWith("cli.js")` so that importing it
 * from a test would not execute the CLI. That guard is false in the one
 * invocation that matters most: npm links a package's bin as a SYMLINK
 * (`node_modules/.bin/cortex -> ../@mocaos/cortex/dist/cli.js`), and argv[1] is
 * the symlink path, so `./node_modules/.bin/cortex --version` exited 0 printing
 * absolutely nothing while `node dist/cli.js --version` worked perfectly. Every
 * POSIX install of the published package was affected; Windows' generated .cmd
 * shim happens to invoke the real path and masked it.
 *
 * The fix is structural rather than a smarter guard: everything worth testing
 * lives in ./args.js, which tests import directly, so this module has no reason
 * to be imported and therefore needs no guard to get wrong.
 */
async function main(): Promise<void> {
  const { verb, flags, positionals } = parseArgs(process.argv.slice(2));

  if (flags.version) { console.log(installerVersion()); return; }
  if (flags.help) { console.log(HELP); return; }

  const { run } = await import(`./commands/${verb}.js`);
  await run({ flags, positionals });
}

main().catch((err: unknown) => {
  p.cancel(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
