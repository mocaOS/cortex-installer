import { resolve } from "node:path";
import { prompts as p } from "../ui.js";
import { findInstallDir, readState, type InstallState } from "../state.js";
import type { ServiceStatus } from "../docker.js";

export function resolveInstall(flags: Record<string, string | boolean>): {
  dir: string;
  state: InstallState;
} {
  const dir = flags.dir ? resolve(String(flags.dir)) : findInstallDir(process.cwd());
  if (!dir) {
    p.cancel(
      "No Cortex install found here or in any parent directory.\n" +
        "  Pass --dir <path>, or run `npx @mocaos/cortex` to create one."
    );
    process.exit(1);
  }
  const state = readState(dir);
  if (!state) {
    p.cancel(`${dir} has no readable cortex.json — is this a Cortex install?`);
    process.exit(1);
  }
  return { dir, state };
}

export function serviceUrl(state: InstallState, service: string): string | null {
  if (state.mode === "domain") {
    if (service === "frontend") return `https://${state.domains!.app}`;
    if (service === "chat") return `https://${state.domains!.chat}`;
    return null;
  }
  if (service === "frontend") return `http://localhost:${state.ports.app}`;
  if (service === "chat") return `http://localhost:${state.ports.chat}`;
  if (service === "backend") return `http://localhost:${state.ports.api}`;
  if (service === "neo4j") return `http://localhost:${state.ports.neo4jHttp}`;
  return null;
}

export function formatStatusTable(rows: ServiceStatus[], state: InstallState): string[] {
  const width = Math.max(8, ...rows.map((r) => r.service.length));
  return rows.map((r) => {
    const status = r.health ?? r.state;
    const url = serviceUrl(state, r.service);
    return `${r.service.padEnd(width)}  ${status.padEnd(9)}  ${url ?? ""}`.trimEnd();
  });
}

/**
 * Strips a secret out of arbitrary text before it is displayed. `doctor`'s
 * closing line explicitly invites the user to paste its output when asking
 * for help, so a provider's raw error text must never carry the configured
 * API key forward — even though the key is sent only as an Authorization
 * header, Cortex supports arbitrary OpenAI-compatible endpoints, and some
 * self-hosted gateways echo request/auth detail back in verbose errors.
 * split/join matches the secret literally, so there is no need to escape
 * regex metacharacters that might appear in it (as a regex .replace would).
 */
export function redactSecret(text: string, secret?: string): string {
  return secret ? text.split(secret).join("***") : text;
}
