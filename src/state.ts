import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Stack } from "./stack.js";

export interface InstallState {
  installer: string;
  stack: string;
  components: Stack["components"];
  mode: "localhost" | "domain";
  projectName: string;
  dir: string;
  installedAt: string;
  providerId: string;
  /**
   * Whether chat is installed. Absent on installs that predate the option —
   * those were always running chat, which is what `update` back-fills.
   */
  chat?: boolean;
  domains?: { app: string; chat?: string; acmeEmail: string };
  ports: { app: number; chat: number; api: number; neo4jHttp: number; neo4jBolt: number };
  /** Kept so `update` can roll back to the previous pins. */
  previous?: { stack: string; components: Stack["components"] };
}

export const STATE_FILE = "cortex.json";

export function readState(dir: string): InstallState | null {
  const p = join(dir, STATE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as InstallState;
  } catch {
    return null;
  }
}

export function writeState(dir: string, state: InstallState): void {
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Walk upwards looking for an install, so day-2 verbs work from anywhere inside it. */
export function findInstallDir(start: string): string | null {
  let cur = resolve(start);
  for (;;) {
    if (existsSync(join(cur, STATE_FILE))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
