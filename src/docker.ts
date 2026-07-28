import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ServiceStatus {
  service: string;
  state: string;
  health: string | null;
}

/**
 * --project-directory pins the project's *identity* (so e.g. `ps` finds this
 * project's containers by label regardless of cwd) and where bind-mount
 * paths and the .env file are read from. COMPOSE_FILE in that .env then
 * selects the overlays, so no -f is needed.
 *
 * It does NOT make the filenames listed in COMPOSE_FILE resolve against
 * `dir` — Compose still resolves those relative paths against the *calling
 * process's* cwd, not --project-directory. Confirmed against the real
 * `docker compose` binary: `--project-directory /x/y config`, run with cwd
 * `/tmp`, fails with `stat /tmp/docker-compose.yml: no such file or
 * directory` even though `/x/y/.env` sets `COMPOSE_FILE=docker-compose.yml:
 * ...`. (`ps` alone doesn't show this — it lists containers by label and
 * never needs to resolve the compose files at all, which is why the gap hid
 * during earlier testing.) Every call site below therefore also passes
 * `cwd: dir` to the child process — that option is what actually makes cwd
 * not matter, not this flag by itself.
 */
export function composeArgs(dir: string): string[] {
  return ["compose", "--project-directory", dir];
}

/**
 * Real `docker compose pull` output (verified against v5.1.3) is THREE tokens:
 *   Image ghcr.io/mocaos/cortex-chat:1.0.0 Pulled
 * plus, for a service built rather than pulled:
 *   backup Skipped No image to be pulled
 * An earlier two-token regex never matched, so the progress counter sat at 0
 * for the whole multi-minute pull — the only feedback the user gets. Both the
 * `Image <ref> <state>` and bare `<name> <state>` shapes are accepted.
 */
export function parsePullProgress(line: string): { image: string; done: boolean } | null {
  const t = line.trim();
  if (/\bSkipped\b/.test(t)) return null;
  const m = t.match(/^(?:Image\s+)?(\S+)\s+(Pulled|Pulling)\b/);
  if (!m) return null;
  return { image: m[1], done: m[2] === "Pulled" };
}

export function parseHealth(psJson: string): ServiceStatus[] {
  const text = psJson.trim();
  if (!text) return [];

  const rows: any[] = [];
  if (text.startsWith("[")) {
    try { rows.push(...JSON.parse(text)); } catch { /* fall through to line-by-line */ }
  }

  // If array parse failed or input is not JSON array, try per-line parsing.
  if (rows.length === 0) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t);
        // If the line is itself an array, spread it; otherwise push the object.
        if (Array.isArray(parsed)) rows.push(...parsed);
        else rows.push(parsed);
      } catch { /* skip unparseable line */ }
    }
  }

  return rows.map((r) => ({
    service: String(r.Service ?? ""),
    state: String(r.State ?? ""),
    health: r.Health ? String(r.Health) : null,
  }));
}

async function run(dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  // docker compose ps writes to stderr even on success (e.g. "variable is not set" warnings).
  // Return them separately so parseHealth can ignore stderr chatter.
  //
  // cwd: dir is load-bearing, not cosmetic — see composeArgs' comment.
  // --project-directory alone does not resolve COMPOSE_FILE's relative
  // filenames against `dir`; only running the child process from `dir` does.
  return exec("docker", [...composeArgs(dir), ...args], {
    maxBuffer: 32 * 1024 * 1024,
    cwd: dir,
  });
}

/** Streams pull progress; onProgress fires once per service transition. */
export function pull(
  dir: string,
  onProgress: (p: { image: string; done: boolean }) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // cwd: dir — see composeArgs' comment; --project-directory is not enough.
    const child = spawn("docker", [...composeArgs(dir), "pull"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: dir,
    });
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
  const result = await run(dir, ["ps", "--format", "json"]);
  return parseHealth(result.stdout);
}

export async function execIn(dir: string, service: string, cmd: string[]): Promise<string> {
  const result = await run(dir, ["exec", "-T", service, ...cmd]);
  // Callers show this output to humans, so include both stdout and stderr.
  return `${result.stdout}${result.stderr}`;
}

/** Attaches `docker compose logs -f` to this process's stdio. */
export function logs(dir: string, service?: string): Promise<number> {
  return new Promise((resolve) => {
    const args = [...composeArgs(dir), "logs", "-f", "--tail", "200"];
    if (service) args.push(service);
    // cwd: dir — see composeArgs' comment; --project-directory is not enough.
    const child = spawn("docker", args, { stdio: "inherit", cwd: dir });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/**
 * The services `waitHealthy` must watch, for a given install mode.
 *
 * caddy is not optional in domain mode — it is the ONLY service that publishes
 * ports there (80, 443, 443/udp), so the four application services can every
 * one of them be healthy while caddy fails to bind :80 or crash-loops on a bad
 * Caddyfile. With caddy left out, the installer printed "All services healthy"
 * followed by https:// URLs that resolved to nothing at all, which is the worst
 * possible ending: it looks like a success.
 *
 * It is equally important NOT to watch caddy in localhost mode, where the caddy
 * overlay is not composed in — the container does not exist, `ps` never lists
 * it, and waitHealthy would spin for the full five-minute timeout waiting for a
 * service that is never coming.
 */
export function healthServices(mode: "localhost" | "domain"): string[] {
  const services = ["neo4j", "backend", "frontend", "chat"];
  if (mode === "domain") services.push("caddy");
  return services;
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
    // Fail fast if any requested service is permanently down (not just starting).
    const dead = services.some((name) => {
      const s = status.find((x) => x.service === name);
      return s && (s.state === "exited" || s.state === "dead");
    });
    if (dead) return false;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
