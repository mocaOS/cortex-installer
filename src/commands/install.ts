import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { fetchStack, assertInstallerSupported } from "../stack.js";
import { runPreflight, existingProjectVolumes } from "../preflight.js";
import { fetchArtifacts } from "../artifacts.js";
import { renderEnv } from "../env.js";
import { writeState } from "../state.js";
import { pull, up, waitHealthy } from "../docker.js";
import { runWizard, buildConfigNonInteractive, checkProjectVolumeCollision } from "../wizard.js";
import { probeChat, probeEmbedding } from "../validate.js";

type Spinner = ReturnType<typeof p.spinner>;

/**
 * The wizard probes the chat and embedding endpoints itself, synchronously
 * as part of building its own config (see wizard.ts) — it never returns
 * until both pass. buildConfigNonInteractive has no equivalent: it is a
 * plain, synchronous function that only validates presence and secret
 * strength, so a bad --yes key or a nonexistent model previously sailed
 * straight through to .env, a ~1.4 GB pull and a container start. This is
 * the --yes path's missing half of "a wrong key fails in seconds" — the
 * failure messaging is copied verbatim from the wizard's probe block so the
 * two paths behave identically.
 */
async function probeLlmOrExit(
  llm: { baseUrl: string; apiKey: string; chatModel: string; embeddingModel: string },
  s: Spinner
): Promise<void> {
  s.start("Testing chat completion");
  const chatProbe = await probeChat({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.chatModel });
  if (!chatProbe.ok) {
    s.stop("Chat probe failed");
    p.log.error(
      `${chatProbe.status ? `HTTP ${chatProbe.status}` : "Request failed"}: ${chatProbe.body ?? ""}`
    );
    p.cancel("The LLM endpoint did not answer. Nothing was written.");
    process.exit(1);
  }
  s.stop(`Chat completion OK (${chatProbe.ms} ms)`);

  s.start("Testing embeddings");
  const embedProbe = await probeEmbedding({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.embeddingModel });
  if (!embedProbe.ok) {
    s.stop("Embedding probe failed");
    p.log.error(
      `${embedProbe.status ? `HTTP ${embedProbe.status}` : "Request failed"}: ${embedProbe.body ?? ""}`
    );
    p.cancel("The embedding endpoint did not answer. Nothing was written.");
    process.exit(1);
  }
  s.stop(`Embeddings OK — ${embedProbe.dimension} dimensions detected`);
}

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

  // --- non-interactive-only gates ------------------------------------------
  // The wizard already satisfies both of these itself before it ever returns
  // a config (project-name collisions and LLM probes, both in wizard.ts).
  // buildConfigNonInteractive cannot: it is synchronous and cannot await
  // Docker or network calls, so --yes needs an equivalent pass here — still
  // before anything is written or pulled. Scoped to --yes only: re-running
  // these after an interactive runWizard would just repeat checks it already
  // made (wasting a network round trip), and for the volume check it would
  // be outright wrong — the wizard's own "reuse" choice leaves the same
  // collision in place on purpose, and re-checking it here with no
  // CORTEX_PROJECT_NAME set would fail a collision the user already chose to
  // keep.
  if (ctx.flags.yes) {
    const existingVolumes = await existingProjectVolumes(cfg.projectName);
    const volumeWarning = checkProjectVolumeCollision(
      cfg.projectName,
      existingVolumes,
      process.env.CORTEX_PROJECT_NAME !== undefined
    );
    if (volumeWarning) p.log.warn(volumeWarning);

    await probeLlmOrExit(cfg.llm, s);
  }

  // --- write, then start --------------------------------------------------
  mkdirSync(dir, { recursive: true });

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
