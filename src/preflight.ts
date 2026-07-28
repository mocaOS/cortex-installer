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

const MIN_NODE = "20.12.0"; // set by @clack/prompts + @clack/core
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

/**
 * Docker volumes are named `<project>_<volume>` and belong to the daemon as a
 * whole — they are NOT scoped to any install directory, and `docker volume
 * ls` lists every project's volumes, from every install anyone has ever run
 * on this machine, forever (until explicitly removed).
 *
 * This matters because Neo4j only reads NEO4J_AUTH — the env var Compose
 * populates from NEO4J_PASSWORD — the FIRST time its data volume is created.
 * If a volume named `<project>_neo4j_data` already exists (e.g. from a
 * previous install that reused the default project name "cortex", or from
 * once running the app's own dev docker-compose.yml locally), a fresh install
 * that picks the same project name writes a newly generated NEO4J_PASSWORD to
 * .env that Neo4j will never apply — the existing volume keeps whatever
 * credentials it was created with. The backend's driver then retries the
 * (wrong, freshly generated) password until Neo4j locks it out, which
 * surfaces only as:
 *
 *   neo4j.exceptions.ClientError: {neo4j_code: Neo.ClientError.Security.AuthenticationRateLimit}
 *
 * in the backend's own logs — a symptom that gives no hint that the real
 * cause is a project-name collision with unrelated, pre-existing data. Since
 * that data might be a real user's graph, uploads or chat history, the fix is
 * to detect the collision and let the wizard offer a different project name
 * — never to delete or overwrite it.
 */
export function filterProjectVolumes(names: string[], projectName: string): string[] {
  const prefix = `${projectName}_`;
  return names.map((n) => n.trim()).filter((n) => n.length > 0 && n.startsWith(prefix));
}

export async function existingProjectVolumes(projectName: string): Promise<string[]> {
  const out = await tryExec("docker", ["volume", "ls", "--format", "{{.Name}}"]);
  return filterProjectVolumes(out.output.split("\n"), projectName);
}

async function tryExec(cmd: string, args: string[]): Promise<{ output: string; notFound: boolean }> {
  try {
    const { stdout, stderr } = await exec(cmd, args);
    return { output: `${stdout}${stderr}`, notFound: false };
  } catch (err: any) {
    const notFound = err?.code === "ENOENT";
    return { output: `${err?.stdout ?? ""}${err?.stderr ?? ""}`, notFound };
  }
}

/** Parses `docker info --format {{json .}}` for MemTotal and DockerRootDir. */
async function dockerInfo(): Promise<{ memGb: number | null; rootDir: string | null }> {
  const { output } = await tryExec("docker", ["info", "--format", "{{json .}}"]);
  try {
    const j = JSON.parse(output);
    return {
      memGb: typeof j.MemTotal === "number" ? j.MemTotal / 1024 ** 3 : null,
      rootDir: typeof j.DockerRootDir === "string" ? j.DockerRootDir : null,
    };
  } catch {
    return { memGb: null, rootDir: null };
  }
}

async function freeDiskGb(path: string): Promise<number | null> {
  const { output } = await tryExec("df", ["-Pk", path]);
  const line = output.trim().split("\n").at(-1) ?? "";
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
  const nodeOk = semver.gte(process.versions.node, MIN_NODE);
  checks.push({
    name: "Node",
    ok: nodeOk,
    detail: nodeOk ? `v${process.versions.node}` : `v${process.versions.node} — need >= ${MIN_NODE}`,
    fatal: true,
  });

  // Docker daemon
  const dvResult = await tryExec("docker", ["version", "--format", "{{.Server.Version}}"]);
  const dv = parseDockerVersion(dvResult.output);
  checks.push({
    name: "Docker daemon",
    ok: dv !== null,
    detail:
      dv ? `${dv}` : dvResult.notFound ? "docker: command not found — install Docker first" : "not reachable — is Docker running?",
    fatal: true,
  });

  // Compose v2 plugin
  const cvResult = await tryExec("docker", ["compose", "version"]);
  const cv = parseComposeVersion(cvResult.output);
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
  checks.push({
    name: "Disk",
    ok: disk !== null && disk >= HARD_DISK_GB,
    detail:
      disk === null
        ? "could not determine free disk space — verify manually that at least 20 GB is free"
        : disk >= MIN_DISK_GB
          ? `${Math.floor(disk)} GB free`
          : `${Math.floor(disk)} GB free — ${MIN_DISK_GB} GB recommended`,
    fatal: disk !== null && disk < HARD_DISK_GB,
  });
  if (info.memGb !== null) {
    checks.push({
      name: "Memory",
      ok: info.memGb >= MIN_RAM_GB,
      detail:
        info.memGb >= WARN_RAM_GB
          ? `${Math.floor(info.memGb)} GB`
          : `${Math.floor(info.memGb)} GB — ${WARN_RAM_GB} GB recommended (Neo4j alone is capped at 4 GB)`,
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
