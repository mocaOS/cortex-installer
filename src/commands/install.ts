import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { fetchStack, assertInstallerSupported } from "../stack.js";
import { runPreflight, existingProjectVolumes } from "../preflight.js";
import { fetchArtifacts } from "../artifacts.js";
import { renderEnv, writeEnvFile } from "../env.js";
import { writeState } from "../state.js";
import { pull, up, waitHealthy, healthServices } from "../docker.js";
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
  llm: {
    baseUrl: string;
    apiKey: string;
    chatModel: string;
    embeddingModel: string;
    embeddingDimension: number;
    embeddingSendDimensions: boolean;
  },
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

  /**
   * The measured dimension is ground truth; CORTEX_EMBEDDING_DIMENSION is only
   * a claim. The wizard has no equivalent of this check because it does not need
   * one — it takes embedProbe.dimension directly. --yes takes the operator's
   * declared value, and previously printed the measured one and then discarded
   * it, so a typo (or a model whose dimension the operator misremembered) wrote
   * the wrong number into .env.
   *
   * That has to be fatal rather than a warning, and it cannot be silently
   * "corrected" to the measured value either. EMBEDDING_DIMENSION is baked into
   * the Neo4j vector index the first time the backend creates it, and changing it
   * afterwards means re-embedding every chunk in the graph — so an install that
   * proceeds on a mismatch is an install the operator has to redo from scratch.
   * Failing here costs them one re-run with the right number.
   */
  if (embedProbe.dimension !== llm.embeddingDimension) {
    p.log.error(
      `Embedding dimension mismatch.\n` +
        `  ${llm.embeddingModel} really returns ${embedProbe.dimension} dimensions, ` +
        `but CORTEX_EMBEDDING_DIMENSION says ${llm.embeddingDimension}.\n` +
        `  This value is baked into the Neo4j vector index on first use and cannot be ` +
        `changed later without re-embedding everything.\n` +
        `  Set CORTEX_EMBEDDING_DIMENSION=${embedProbe.dimension} (or point ` +
        `CORTEX_EMBEDDING_MODEL at a model that really is ${llm.embeddingDimension}-dimensional).`
    );
    p.cancel("Refusing to bake a wrong dimension into the graph. Nothing was written.");
    process.exit(1);
  }

  // Not fatal: getting this wrong costs one rejected request per embedding call
  // at worst, and the backend can be corrected in .env afterwards without
  // touching the index.
  if (embedProbe.sendDimensions !== llm.embeddingSendDimensions) {
    p.log.warn(
      `CORTEX_EMBEDDING_SEND_DIMENSIONS is ${llm.embeddingSendDimensions}, but this ` +
        `endpoint ${embedProbe.sendDimensions ? "does" : "does not"} accept an explicit ` +
        `\`dimensions\` parameter. ${embedProbe.sendDimensions ? "Leaving it off is safe." : `Set it to false.`}`
    );
  }
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

  /**
   * cortex.json alone is not enough of a guard. `install --dir .` into a
   * directory that is not a Cortex install but is not empty either — the
   * overwhelmingly likely case being an existing project, or a second install
   * attempt that was interrupted before writing state — silently destroys
   * files: fetchArtifacts cpSync's the release's whole selfhost/ tree over the
   * target (README.md among them) and .env is then written unconditionally.
   * Losing a .env means losing the only copy of NEO4J_PASSWORD, which Neo4j
   * only ever honours at first volume creation, so it is unrecoverable.
   *
   * Refuse up front, naming the files, rather than after the manifest fetch and
   * the entire wizard.
   */
  const CLOBBERABLE = [".env", "docker-compose.yml", "README.md"];
  const present = CLOBBERABLE.filter((f) => existsSync(join(dir, f)));
  if (present.length) {
    p.cancel(
      `${dir} already contains files this install would overwrite:\n` +
        present.map((f) => `  - ${f}`).join("\n") +
        `\n\n  Point --dir at an empty directory, or move these files aside first.\n` +
        `  If this is the leftover of an install that failed part-way through — there\n` +
        `  is no cortex.json, so nothing here is a working install — check whether\n` +
        `  .env holds a NEO4J_PASSWORD you still need, then remove the directory and\n` +
        `  re-run.\n\n  Nothing was written.`
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
  // No ports in THIS pass: which ports matter is not known until the mode and
  // port config exist, and the interactive wizard resolves localhost conflicts
  // itself (resolvePorts) so checking the defaults here would only produce a
  // warning it immediately fixes. Ports are checked below, once cfg is known —
  // including domain mode, which does publish 80/443 via caddy. (An earlier
  // version of this comment claimed domain mode published no ports at all,
  // which is how both --yes and domain mode ended up with no port check.)
  const pre = await runPreflight({ dir });
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

    /**
     * Ports. The wizard has resolvePorts for localhost and (now) a warn-plus-
     * confirm for 80/443 in domain mode; --yes can do neither, and previously
     * did nothing at all — runPreflight({}) above probes no ports, so a busy
     * port only surfaced as a `docker compose up` bind failure after the full
     * 1.7 GB image pull.
     *
     * portsFatal makes an occupied port abort here instead. Only a genuine
     * EADDRINUSE is fatal: probing 80/443 as a non-root user fails with EACCES,
     * which means "cannot check", not "occupied", and must never abort — see
     * probePort in preflight.ts.
     */
    const portsToCheck =
      cfg.mode === "domain" ? [80, 443] : Object.values(cfg.ports);
    s.start("Checking ports");
    const portPre = await runPreflight({ ports: portsToCheck, portsFatal: true });
    s.stop("Ports checked");
    for (const c of portPre.checks.filter((x) => x.port !== undefined)) {
      const line = `${c.name}: ${c.detail}`;
      if (c.ok) p.log.success(line);
      else if (c.fatal) p.log.error(line);
      else p.log.warn(line);
    }
    if (!portPre.ok) {
      p.cancel(
        `A port this install needs is already in use. Free it, or set the ` +
          `CORTEX_*_PORT variables to something else. Nothing was written.`
      );
      process.exit(1);
    }

    await probeLlmOrExit(cfg.llm, s);
  }

  // --- write, then start --------------------------------------------------
  mkdirSync(dir, { recursive: true });

  s.start("Fetching release artifacts");
  await fetchArtifacts({ version: stack.stack, dir });
  s.stop("Release artifacts in place");

  // Same writer as `update` — creates the file already at mode 600 rather than
  // writing it world-readable and chmod'ing afterwards. See writeEnvFile.
  const envPath = join(dir, ".env");
  writeEnvFile(envPath, renderEnv(cfg));
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
  // In domain mode this includes caddy, which is the only service publishing
  // ports there — see healthServices. Without it the URLs printed below could
  // be announced as working while nothing was listening on 80/443 at all.
  const healthy = await waitHealthy(dir, healthServices(cfg.mode), 300_000, (st) => {
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
