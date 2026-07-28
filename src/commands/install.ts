import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { fetchStack, assertInstallerSupported } from "../stack.js";
import { runPreflight } from "../preflight.js";
import { fetchArtifacts } from "../artifacts.js";
import { renderEnv } from "../env.js";
import { writeState } from "../state.js";
import { pull, up, waitHealthy } from "../docker.js";
import { runWizard, buildConfigNonInteractive } from "../wizard.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  const version = installerVersion();
  banner(version);

  const dir = resolve(String(ctx.flags.dir ?? "./cortex"));
  if (existsSync(join(dir, "cortex.json"))) {
    p.cancel(
      `${dir} already contains an install.\n` +
        `  Use \`cortex update\` to move it to the latest release, or ` +
        `\`cortex config\` to change settings.`
    );
    process.exit(1);
  }

  // --- stack manifest -----------------------------------------------------
  const s = p.spinner();
  s.start("Reading the latest release manifest");
  const stack = await fetchStack({ version: ctx.flags.stack ? String(ctx.flags.stack) : undefined });
  assertInstallerSupported(stack, version);
  s.stop(`Cortex ${stack.stack}`);
  noteBox("Stack", [
    `backend   ${stack.components.backend}`,
    `frontend  ${stack.components.frontend}`,
    `chat      ${stack.components.chat}`,
    `neo4j     ${stack.components.neo4j}`,
  ]);

  // --- preflight ----------------------------------------------------------
  s.start("Checking your environment");
  // No ports here: the wizard resolves port conflicts interactively (and
  // domain mode publishes none), so checking defaults now would only produce a
  // warning the wizard immediately fixes.
  const pre = await runPreflight({});
  s.stop("Environment checked");
  for (const c of pre.checks) {
    const line = `${c.name}: ${c.detail}`;
    if (c.ok) p.log.success(line);
    else if (c.fatal) p.log.error(line);
    else p.log.warn(line);
  }
  if (!pre.ok) {
    p.cancel("Preflight failed. Fix the errors above and re-run.");
    process.exit(1);
  }

  // --- configuration ------------------------------------------------------
  const cfg = ctx.flags.yes
    ? buildConfigNonInteractive(process.env, stack, dir)
    : await runWizard({ stack, dir });

  // --- write, then start --------------------------------------------------
  mkdirSync(dir, { recursive: true });

  // `docker compose --project-directory` (composeArgs) only governs bind-mount
  // and .env resolution — it does NOT change where Compose looks for the files
  // named in COMPOSE_FILE (read from that .env). Those are resolved against
  // the process's cwd. Without this chdir, `pull`/`up`/`ps` in docker.ts stat
  // "<cwd>/docker-compose.ports.yml" instead of "<dir>/docker-compose.ports.yml"
  // — which fails outright, or worse, silently matches an unrelated compose
  // file if cwd happens to contain one (confirmed against the real `docker
  // compose` binary: this is not hypothetical). This is the only place that
  // can fix it without changing docker.ts's signatures, and it is safe here:
  // every path used above this line is already absolute, and nothing below
  // it depends on the pre-install cwd.
  process.chdir(dir);

  s.start("Fetching release artifacts");
  await fetchArtifacts({ version: stack.stack, dir });
  s.stop("Release artifacts in place");

  const envPath = join(dir, ".env");
  writeFileSync(envPath, renderEnv(cfg));
  chmodSync(envPath, 0o600);
  p.log.success(`Wrote ${envPath} (mode 600)`);

  writeState(dir, {
    installer: version,
    stack: stack.stack,
    components: stack.components,
    mode: cfg.mode,
    projectName: cfg.projectName,
    dir,
    installedAt: new Date().toISOString(),
    providerId: cfg.llm.providerId,
    domains: cfg.domains,
    ports: cfg.ports,
  });

  const pulled = new Set<string>();
  s.start("Pulling images");
  await pull(dir, ({ image, done }) => {
    if (done) {
      pulled.add(image);
      s.message(`Pulling images — ${pulled.size} done`);
    }
  });
  s.stop(`Pulled ${pulled.size} images`);

  s.start("Starting the stack");
  await up(dir);
  s.stop("Stack started");

  s.start("Waiting for services to become healthy");
  const healthy = await waitHealthy(dir, ["neo4j", "backend", "frontend", "chat"], 300_000, (st) => {
    s.message(`Waiting — ${st.map((x) => `${x.service}:${x.health ?? x.state}`).join(" ")}`);
  });
  s.stop(healthy ? "All services healthy" : "Timed out waiting for health");

  if (!healthy) {
    p.log.warn(`Run \`npx @mocaos/cortex logs\` in ${dir} to see what is wrong.`);
  }

  const urls =
    cfg.mode === "localhost"
      ? [`Cortex   http://localhost:${cfg.ports.app}`, `Chat     http://localhost:${cfg.ports.chat}`]
      : [`Cortex   https://${cfg.domains!.app}`, `Chat     https://${cfg.domains!.chat}`];

  noteBox("Cortex is running", [
    ...urls,
    "",
    `Login    ${cfg.adminEmail}`,
    `Password ${cfg.secrets.adminPassword}`,
    "",
    "This password is shown once. It is stored in .env.",
  ]);
  p.outro("npx @mocaos/cortex status · logs · update");
}
