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

async function run(
  dir: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  // docker compose ps writes to stderr even on success (e.g. "variable is not set" warnings).
  // Return them separately so parseHealth can ignore stderr chatter.
  //
  // cwd: dir is load-bearing, not cosmetic — see composeArgs' comment.
  // --project-directory alone does not resolve COMPOSE_FILE's relative
  // filenames against `dir`; only running the child process from `dir` does.
  //
  // env, when given, is merged OVER a copy of process.env and passed only to
  // this child process — process.env itself is never written to. Mutating it
  // would leak an overlay like DOWN_ENV into every later Compose call made by
  // this same process (e.g. `restart`, which runs `down` then `up` back to
  // back) and silently re-enable a profile the operator's .env does not select.
  return exec("docker", [...composeArgs(dir), ...args], {
    maxBuffer: 32 * 1024 * 1024,
    cwd: dir,
    ...(env ? { env: { ...process.env, ...env } } : {}),
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

/**
 * --build is required, not an optimisation. Every app service uses a prebuilt
 * GHCR image, but the backup sidecar is built locally from the release's
 * ops/backup directory (see selfhost/docker-compose.yml). Compose builds a
 * missing image but never rebuilds an existing one just because its context
 * changed, so without --build an `update` that downloads corrected backup or
 * restore scripts would keep running the sidecar image built at install time —
 * the fix would land on disk and never reach the container. Rebuild cost is a
 * COPY of two shell scripts onto a cached base, so this is nearly free when
 * nothing changed.
 */
export const UP_ARGS = ["up", "-d", "--remove-orphans", "--build"];

export async function up(dir: string): Promise<void> {
  await run(dir, [...UP_ARGS]);
}

/** Env overlay for `down` — see the comment on `down` for why chat is named. */
export const DOWN_ENV = { COMPOSE_PROFILES: "chat" } as const;

/**
 * `COMPOSE_PROFILES=chat` is set unconditionally here, and it is not a bug.
 *
 * Compose filters by profile on the way DOWN as well as up, so a `down` issued
 * while the chat profile is inactive leaves a running chat container untouched —
 * verified live, and `--remove-orphans` does not help, because a profile-gated
 * service is still *defined*, merely inactive. That would make `stop` and
 * `restart` silently incomplete, and `uninstall` leave a container behind after
 * the user asked for the whole install to be removed.
 *
 * Naming the profile here means `down` always addresses every container the
 * project owns, whatever `.env` currently selects. It is also what makes
 * turning chat off a `.env` edit plus `restart`, rather than a manual
 * `docker compose rm`.
 */
export async function down(dir: string, volumes = false): Promise<void> {
  await run(dir, volumes ? ["down", "-v"] : ["down"], DOWN_ENV);
}

export async function ps(dir: string): Promise<ServiceStatus[]> {
  const result = await run(dir, ["ps", "--format", "json"]);
  return parseHealth(result.stdout);
}

/**
 * Validates the .env + compose files on disk exactly the way `pull`/`up` are
 * about to read them — without connecting to anything. `config -q` only
 * parses and interpolates, then exits non-zero on any failure.
 *
 * This is the generic backstop `update` runs right after rewriting .env (see
 * commands/update.ts): three Criticals in this feature's own review came from
 * this installer's COMPOSE_PROFILES editing disagreeing with Compose's real
 * dotenv parser (quoting, inline comments, and which of two duplicate lines
 * wins — see ensureChatProfile's doc comment in update.ts for all three). That
 * case space is unbounded, so rather than assume the last gap was found, this
 * validates the actual combination Compose will see and lets the caller
 * restore the previous .env on failure instead of leaving a half-written
 * directory where every subsequent `docker compose` call also fails.
 */
export async function validateComposeConfig(dir: string): Promise<{ ok: boolean; stderr: string }> {
  try {
    await run(dir, ["config", "-q"]);
    return { ok: true, stderr: "" };
  } catch (err: any) {
    return { ok: false, stderr: String(err?.stderr ?? err?.message ?? err) };
  }
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
 *
 * chat works the same way: it is profile-gated, off by default (see Task 5/6),
 * so `chat` here must reflect whether it was actually installed, not merely be
 * assumed. Naming it when Compose was never asked to create it means
 * waitHealthy polls for the full 300s and then reports a false failure on an
 * otherwise healthy stack.
 */
export function healthServices(mode: "localhost" | "domain", chat: boolean): string[] {
  const services = ["neo4j", "backend", "frontend"];
  // Only name services Compose was actually asked to create: waitHealthy polls
  // until each one appears, so an uninstalled chat means a full-timeout spin
  // ending in a false failure.
  if (chat) services.push("chat");
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
