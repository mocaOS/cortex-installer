import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import semver from "semver";

const exec = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed fatal check aborts the install. */
  fatal: boolean;
}
export interface PreflightReport {
  ok: boolean;
  checks: Check[];
}

const MIN_COMPOSE = "2.20.0";
const MIN_DISK_GB = 20;
const HARD_DISK_GB = 10;
const WARN_RAM_GB = 8;
const MIN_RAM_GB = 6;

export function parseDockerVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function parseComposeVersion(out: string): string | null {
  const m = out.match(/version\s+v?(\d+\.\d+\.\d+)/i);
  return m ? m[1] : null;
}

export function checkArch(arch: string): { ok: boolean; message?: string } {
  if (arch === "x64" || arch === "arm64") return { ok: true };
  return {
    ok: false,
    message:
      `Unsupported architecture "${arch}". Published images cover linux/amd64 ` +
      `and linux/arm64 only.`,
  };
}

export function checkPort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function tryExec(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec(cmd, args);
    return `${stdout}${stderr}`;
  } catch (err: any) {
    return `${err?.stdout ?? ""}${err?.stderr ?? err?.message ?? ""}`;
  }
}

/** Parses `docker info --format {{json .}}` for MemTotal and DockerRootDir. */
async function dockerInfo(): Promise<{ memGb: number | null; rootDir: string | null }> {
  const out = await tryExec("docker", ["info", "--format", "{{json .}}"]);
  try {
    const j = JSON.parse(out);
    return {
      memGb: typeof j.MemTotal === "number" ? j.MemTotal / 1024 ** 3 : null,
      rootDir: typeof j.DockerRootDir === "string" ? j.DockerRootDir : null,
    };
  } catch {
    return { memGb: null, rootDir: null };
  }
}

async function freeDiskGb(path: string): Promise<number | null> {
  const out = await tryExec("df", ["-Pk", path]);
  const line = out.trim().split("\n").at(-1) ?? "";
  const cols = line.split(/\s+/);
  const availKb = Number(cols[3]);
  return Number.isFinite(availKb) ? availKb / 1024 ** 2 : null;
}

export async function runPreflight(opts: {
  ports?: number[];
  bindAddr?: string;
}): Promise<PreflightReport> {
  const checks: Check[] = [];

  // Node
  const nodeOk = semver.gte(process.versions.node, "18.0.0");
  checks.push({
    name: "Node",
    ok: nodeOk,
    detail: nodeOk ? `v${process.versions.node}` : `v${process.versions.node} — need >= 18`,
    fatal: true,
  });

  // Docker daemon
  const dv = parseDockerVersion(await tryExec("docker", ["version", "--format", "{{.Server.Version}}"]));
  checks.push({
    name: "Docker daemon",
    ok: dv !== null,
    detail: dv ? `${dv}` : "not reachable — is Docker running?",
    fatal: true,
  });

  // Compose v2 plugin
  const cv = parseComposeVersion(await tryExec("docker", ["compose", "version"]));
  const cvOk = cv !== null && semver.gte(cv, MIN_COMPOSE);
  checks.push({
    name: "Compose v2",
    ok: cvOk,
    detail:
      cv === null
        ? "plugin missing. `apt install docker.io` omits it — install Docker's " +
          "official packages or Docker Desktop."
        : cvOk
          ? `v${cv}`
          : `v${cv} — need >= ${MIN_COMPOSE}`,
    fatal: true,
  });

  // Architecture
  const arch = checkArch(process.arch);
  checks.push({
    name: "Architecture",
    ok: arch.ok,
    detail: arch.ok ? process.arch : arch.message!,
    fatal: true,
  });

  // Disk + RAM
  const info = await dockerInfo();
  const disk = info.rootDir ? await freeDiskGb(info.rootDir) : null;
  if (disk !== null) {
    checks.push({
      name: "Disk",
      ok: disk >= HARD_DISK_GB,
      detail:
        disk >= MIN_DISK_GB
          ? `${disk.toFixed(0)} GB free`
          : `${disk.toFixed(0)} GB free — ${MIN_DISK_GB} GB recommended`,
      fatal: disk < HARD_DISK_GB,
    });
  }
  if (info.memGb !== null) {
    checks.push({
      name: "Memory",
      ok: info.memGb >= MIN_RAM_GB,
      detail:
        info.memGb >= WARN_RAM_GB
          ? `${info.memGb.toFixed(0)} GB`
          : `${info.memGb.toFixed(0)} GB — ${WARN_RAM_GB} GB recommended (Neo4j alone is capped at 4 GB)`,
      fatal: info.memGb < MIN_RAM_GB,
    });
  }

  // Ports (localhost mode only)
  for (const port of opts.ports ?? []) {
    const free = await checkPort(port, opts.bindAddr ?? "127.0.0.1");
    checks.push({
      name: `Port ${port}`,
      ok: free,
      detail: free ? "free" : "in use — choose another",
      fatal: false,
    });
  }

  return { ok: checks.every((c) => c.ok || !c.fatal), checks };
}
