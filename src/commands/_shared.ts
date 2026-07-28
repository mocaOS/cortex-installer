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
