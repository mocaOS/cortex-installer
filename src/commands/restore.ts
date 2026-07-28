import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { execIn } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: {
  flags: Record<string, string | boolean>;
  positionals: string[];
}): Promise<void> {
  banner(installerVersion());
  const { dir, state } = resolveInstall(ctx.flags);

  // Exclude LAST_SUCCESS and the `latest` symlink backup.sh maintains — the
  // latter would otherwise appear as a selectable entry that sorts ahead of
  // every real timestamp, duplicating whichever backup it points at.
  const listing = await execIn(dir, "backup", [
    "sh",
    "-c",
    "ls -1 /backups | grep -vE '^(LAST_SUCCESS|latest)$' || true",
  ]);
  const stamps = listing.trim().split("\n").filter(Boolean);
  if (!stamps.length) { p.cancel("No backups found."); return; }

  let stamp = ctx.positionals[0];
  if (!stamp) {
    const picked = await p.select({
      message: "Which backup?",
      options: stamps.slice(-20).reverse().map((t) => ({ value: t, label: t })),
    });
    if (p.isCancel(picked)) { p.cancel("Cancelled."); return; }
    stamp = String(picked);
  }

  noteBox("Restoring is destructive", [
    `This wipes the current graph and replays ${stamp}.`,
    "",
    "The graph restore alone does NOT bring back uploads, skills, apps or",
    "chat data — those live in file volumes and need the extra step below,",
    "because the sidecar mounts them read-only.",
    "",
    "Full runbook: ops/backup/restore.sh header, and selfhost/README.md.",
  ]);

  const typed = await p.text({ message: `Type "restore" to confirm`, validate: (v) => (v === "restore" ? undefined : "Type restore to continue") });
  if (p.isCancel(typed)) { p.cancel("Cancelled."); return; }

  // No spinner and no partial execution here on purpose: step 3 needs
  // host-level `docker run` to write volumes the sidecar mounts read-only, so
  // wrapping only some steps would leave the operator with a half-restored
  // instance and no signal about it. Print the whole runbook.
  //
  // The steps are numbered explicitly because the prose has to refer to one of
  // them, and an unnumbered list plus a bare "step 2" is exactly how that
  // reference drifted out of sync with the list it describes.
  p.log.warn(
    `Now run these from ${dir}, in order — they need host-level docker access\n` +
      `that this CLI deliberately does not wrap, because step 3 writes to volumes\n` +
      `the backup sidecar can only read:\n\n` +
      `  1. docker compose stop backend\n\n` +
      `  2. docker compose exec -e RESTORE_WIPE=yes backup /restore.sh ${stamp}\n\n` +
      `  3. docker run --rm \\\n` +
      `       -v ${state.projectName}_uploads_data:/data/uploads \\\n` +
      `       -v ${state.projectName}_custom_inputs_data:/data/custom_inputs \\\n` +
      `       -v ${state.projectName}_chat_data:/data/chat \\\n` +
      `       -v ${state.projectName}_skills_data:/data/skills \\\n` +
      `       -v ${state.projectName}_apps_data:/data/apps \\\n` +
      `       -v ${state.projectName}_backups:/backups:ro \\\n` +
      `       alpine tar -xzf /backups/${stamp}/files.tar.gz -C /\n\n` +
      `  4. docker compose start backend`
  );
  p.outro("Follow steps 1 to 4 above in order.");
}
