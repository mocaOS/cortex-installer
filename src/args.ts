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

export const HELP = `
  cortex — installer and manager for self-hosted Cortex

  Usage
    npx @mocaos/cortex [command] [options]

  Commands
    install            Interactive setup (default)
    update             Move an install to the latest released stack
    config             Show where settings live and how to change them
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
