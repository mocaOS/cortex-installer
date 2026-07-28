#!/usr/bin/env node
import * as p from "@clack/prompts";
import { installerVersion } from "./version.js";

export interface ParsedArgs {
  verb: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

const VERBS = new Set([
  "install", "update", "config", "status", "logs",
  "start", "stop", "restart", "backup", "restore",
  "doctor", "uninstall",
]);

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set(["dir", "config", "stack"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (VALUE_FLAGS.has(body) && argv[i + 1] && !argv[i + 1].startsWith("-")) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      rest.push(tok);
    }
  }

  if (rest.length && !VERBS.has(rest[0])) {
    throw new Error(
      `Unknown command "${rest[0]}". Run \`npx @mocaos/cortex --help\` for the list.`
    );
  }
  const verb = rest.length ? rest.shift()! : "install";
  return { verb, flags, positionals: rest };
}

const HELP = `
  cortex — installer and manager for self-hosted Cortex

  Usage
    npx @mocaos/cortex [command] [options]

  Commands
    install            Interactive setup (default)
    update             Move an install to the latest released stack
    config             Re-run the wizard against an existing install
    status             Service state, health and URLs
    logs [service]     Follow logs
    start|stop|restart Lifecycle
    backup             Run a verified backup now
    restore <stamp>    Restore from a backup
    doctor             Diagnose an install
    uninstall          Remove containers, optionally volumes

  Options
    --dir <path>       Install directory (default ./cortex, or discovered upwards)
    --yes              Non-interactive; take values from the environment
    --no-color         Disable colour
    --version          Print the installer version
    --help             Show this
`;

async function main(): Promise<void> {
  const { verb, flags, positionals } = parseArgs(process.argv.slice(2));

  if (flags.version) { console.log(installerVersion()); return; }
  if (flags.help) { console.log(HELP); return; }

  const { run } = await import(`./commands/${verb}.js`);
  await run({ flags, positionals });
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  main().catch((err: unknown) => {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
