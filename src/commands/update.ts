import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeEnvFile } from "../env.js";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { fetchStack, assertInstallerSupported } from "../stack.js";
import { fetchArtifacts } from "../artifacts.js";
import { writeState, chatEnabledFor } from "../state.js";
import { pull, up, waitHealthy, healthServices, execIn } from "../docker.js";
import { diffComponents, rewriteImagePins } from "../update.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  const version = installerVersion();
  banner(version);
  const { dir, state } = resolveInstall(ctx.flags);

  const s = p.spinner();
  s.start("Checking for a newer release");
  const latest = await fetchStack({ version: ctx.flags.stack ? String(ctx.flags.stack) : undefined });
  assertInstallerSupported(latest, version);
  s.stop(`Installed ${state.stack} · available ${latest.stack}`);

  const diff = diffComponents(state.components, latest.components);
  if (!diff.some((d) => d.changed)) {
    p.outro(`Already on ${state.stack}. Nothing to do.`);
    return;
  }

  noteBox("Changes", diff.map((d) =>
    d.changed ? `${d.name.padEnd(9)} ${d.from} → ${d.to}` : `${d.name.padEnd(9)} ${d.from} (unchanged)`
  ));

  if (!ctx.flags.yes) {
    const go = await p.confirm({ message: `Update to ${latest.stack}?`, initialValue: true });
    if (p.isCancel(go) || !go) { p.cancel("Cancelled. Nothing changed."); return; }

    const backup = await p.confirm({ message: "Run a backup first?", initialValue: true });
    if (!p.isCancel(backup) && backup) {
      s.start("Backing up");
      try {
        await execIn(dir, "backup", ["/backup.sh"]);
        s.stop("Backup complete");
      } catch (err) {
        s.stop("Backup failed");
        p.log.error(String((err as Error).message).slice(0, 400));
        const anyway = await p.confirm({ message: "Continue without a fresh backup?", initialValue: false });
        if (p.isCancel(anyway) || !anyway) { p.cancel("Cancelled."); return; }
      }
    }
  }

  // Refresh compose files + ops/ from the new tag, then repin .env.
  //
  // chatEnabledFor(state) for now — this is the PRE-update state, so on an
  // install that predates the chat option it reads absent-as-enabled, which is
  // correct today. Task 9 replaces this with the value update back-fills into
  // the new state, once back-filling exists.
  s.start("Fetching release artifacts");
  await fetchArtifacts({ version: latest.stack, dir, chat: chatEnabledFor(state) });
  s.stop("Release artifacts updated");

  // Atomic: this file holds the only copy of NEO4J_PASSWORD, and a truncating
  // write that dies mid-flight makes the graph permanently unauthenticatable.
  // See writeEnvFile.
  const envPath = join(dir, ".env");
  writeEnvFile(envPath, rewriteImagePins(readFileSync(envPath, "utf8"), latest.components));
  p.log.success("Repinned images in .env (your other settings untouched)");

  const pulled = new Set<string>();
  s.start("Pulling images");
  await pull(dir, ({ image, done }) => { if (done) { pulled.add(image); s.message(`Pulling — ${pulled.size} done`); } });
  s.stop(`Pulled ${pulled.size} images`);

  s.start("Recreating containers");
  await up(dir);
  s.stop("Containers recreated");

  s.start("Waiting for health");
  // state.mode decides whether caddy is part of the stack — see healthServices.
  // An update that leaves caddy crash-looping on the new version is exactly the
  // case this must not report as healthy.
  //
  // chatEnabledFor(state) for now — this is the PRE-update state, so on an
  // install that predates the chat option it reads absent-as-enabled, which is
  // correct today. Task 9 replaces this with the value update back-fills into
  // the new state, once back-filling exists.
  const ok = await waitHealthy(dir, healthServices(state.mode, chatEnabledFor(state)));
  s.stop(ok ? "All services healthy" : "Timed out waiting for health");

  writeState(dir, {
    ...state,
    installer: version,
    stack: latest.stack,
    components: latest.components,
    previous: { stack: state.stack, components: state.components },
  });

  if (!ok) {
    // `state` here is still the PRE-update state: writeState above wrote a new
    // object to disk but never reassigned this binding, so state.stack and
    // state.components are genuinely the previous release's.
    //
    // The five .env lines alone are not a rollback and never were. fetchArtifacts
    // has already replaced docker-compose.yml, the overlays, Caddyfile.template
    // and ops/ with the NEW release's copies, so repinning the images by hand
    // leaves old images running against new compose files — a combination that
    // was never tested. `cortex update --stack <previous>` re-fetches that
    // release's artifacts AND repins .env to match, which is the only sequence
    // that actually restores the previous install. The manual lines stay as a
    // fallback for when the release manifest itself is unreachable.
    const prev = state.components;
    p.log.error(
      `Health check timed out on ${latest.stack}. To go back to ${state.stack}:\n\n` +
        `  npx @mocaos/cortex update --stack ${state.stack}\n\n` +
        `That re-fetches ${state.stack}'s compose files and repins .env together — ` +
        `note that editing .env alone is NOT enough, because the compose files in ` +
        `this directory have already been replaced with ${latest.stack}'s.\n` +
        `If the manifest is unreachable, restore these pins by hand (also recorded ` +
        `as \`previous\` in cortex.json) and re-fetch ${state.stack}'s artifacts:\n` +
        `  CORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:${prev.backend}\n` +
        `  CORTEX_FRONTEND_IMAGE=ghcr.io/mocaos/cortex-frontend:${prev.frontend}\n` +
        `  CORTEX_CHAT_IMAGE=ghcr.io/mocaos/cortex-chat:${prev.chat}\n` +
        `  NEO4J_VERSION=${prev.neo4j}\n` +
        `  CADDY_VERSION=${prev.caddy}`
    );
  }
  p.outro(ok ? `Now on Cortex ${latest.stack}.` : "Update finished with warnings.");
}
