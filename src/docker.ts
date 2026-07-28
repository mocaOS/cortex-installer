import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ServiceStatus {
  service: string;
  state: string;
  health: string | null;
}

/**
 * --project-directory makes every verb independent of the caller's cwd.
 * COMPOSE_FILE in the install's .env selects the overlays, so no -f is needed.
 */
export function composeArgs(dir: string): string[] {
  return ["compose", "--project-directory", dir];
}

export function parsePullProgress(line: string): { image: string; done: boolean } | null {
  const m = line.trim().match(/^(\S+)\s+(Pulled|Pulling)$/);
  if (!m) return null;
  return { image: m[1], done: m[2] === "Pulled" };
}

export function parseHealth(psJson: string): ServiceStatus[] {
  const text = psJson.trim();
  if (!text) return [];

  const rows: any[] = [];
  if (text.startsWith("[")) {
    try { rows.push(...JSON.parse(text)); } catch { /* fall through */ }
  } else {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { /* skip */ }
    }
  }

  return rows.map((r) => ({
    service: String(r.Service ?? ""),
    state: String(r.State ?? ""),
    health: r.Health ? String(r.Health) : null,
  }));
}

async function run(dir: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await exec("docker", [...composeArgs(dir), ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

/** Streams pull progress; onProgress fires once per service transition. */
export function pull(
  dir: string,
  onProgress: (p: { image: string; done: boolean }) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...composeArgs(dir), "pull"], { stdio: ["ignore", "pipe", "pipe"] });
    const handle = (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        const p = parsePullProgress(line);
        if (p) onProgress(p);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker compose pull exited ${code}`))
    );
  });
}

export async function up(dir: string): Promise<void> {
  await run(dir, ["up", "-d", "--remove-orphans"]);
}

export async function down(dir: string, volumes = false): Promise<void> {
  await run(dir, volumes ? ["down", "-v"] : ["down"]);
}

export async function ps(dir: string): Promise<ServiceStatus[]> {
  return parseHealth(await run(dir, ["ps", "--format", "json"]));
}

export async function execIn(dir: string, service: string, cmd: string[]): Promise<string> {
  return run(dir, ["exec", "-T", service, ...cmd]);
}

/** Attaches `docker compose logs -f` to this process's stdio. */
export function logs(dir: string, service?: string): Promise<number> {
  return new Promise((resolve) => {
    const args = [...composeArgs(dir), "logs", "-f", "--tail", "200"];
    if (service) args.push(service);
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/**
 * Waits for the named services to report healthy. Services without a
 * healthcheck (frontend, chat, caddy) are satisfied by `running`.
 */
export async function waitHealthy(
  dir: string,
  services: string[],
  timeoutMs = 300_000,
  onTick?: (s: ServiceStatus[]) => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await ps(dir);
    onTick?.(status);
    const ready = services.every((name) => {
      const s = status.find((x) => x.service === name);
      if (!s) return false;
      if (s.health) return s.health === "healthy";
      return s.state === "running";
    });
    if (ready) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
