import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { fetchStack, assertInstallerSupported } from "../stack.js";
import { fetchArtifacts } from "../artifacts.js";
import { writeState } from "../state.js";
import { pull, up, waitHealthy, execIn } from "../docker.js";
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
  s.start("Fetching release artifacts");
  await fetchArtifacts({ version: latest.stack, dir });
  s.stop("Release artifacts updated");

  const envPath = join(dir, ".env");
  writeFileSync(envPath, rewriteImagePins(readFileSync(envPath, "utf8"), latest.components));
  chmodSync(envPath, 0o600);
  p.log.success("Repinned images in .env (your other settings untouched)");

  const pulled = new Set<string>();
  s.start("Pulling images");
  await pull(dir, ({ image, done }) => { if (done) { pulled.add(image); s.message(`Pulling — ${pulled.size} done`); } });
  s.stop(`Pulled ${pulled.size} images`);

  s.start("Recreating containers");
  await up(dir);
  s.stop("Containers recreated");

  s.start("Waiting for health");
  const ok = await waitHealthy(dir, ["neo4j", "backend", "frontend", "chat"]);
  s.stop(ok ? "All services healthy" : "Timed out waiting for health");

  writeState(dir, {
    ...state,
    installer: version,
    stack: latest.stack,
    components: latest.components,
    previous: { stack: state.stack, components: state.components },
  });

  if (!ok) {
    p.log.error(
      `Health check timed out. Previous pins are recorded in cortex.json.\n` +
        `  To roll back: edit the CORTEX_*_IMAGE lines in .env back to ${state.stack}, ` +
        `then run \`cortex start\`.`
    );
  }
  p.outro(ok ? `Now on Cortex ${latest.stack}.` : "Update finished with warnings.");
}
