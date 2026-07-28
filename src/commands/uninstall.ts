import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { down } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir, state } = resolveInstall(ctx.flags);

  const s = p.spinner();
  s.start("Removing containers");
  await down(dir, false);
  s.stop("Containers removed — volumes still intact");

  noteBox("Your data is still here", [
    "Removing volumes deletes, permanently:",
    "  the knowledge graph, uploaded documents, installed skills and apps,",
    "  chat accounts and history, and every backup.",
    "",
    `Volumes are prefixed ${state.projectName}_`,
  ]);

  const wipe = await p.confirm({ message: "Delete the data volumes too?", initialValue: false });
  if (p.isCancel(wipe) || !wipe) {
    p.outro(`Kept. Bring it back with \`cortex start\` in ${dir}.`);
    return;
  }

  const typed = await p.text({
    message: `Type "delete my data" to confirm`,
    validate: (v) => (v === "delete my data" ? undefined : "Type it exactly, or Ctrl-C to abort"),
  });
  if (p.isCancel(typed)) { p.outro("Kept."); return; }

  s.start("Removing volumes");
  await down(dir, true);
  s.stop("Volumes removed");
  p.outro(`Done. ${dir} still holds .env and cortex.json — delete it by hand if you want it gone.`);
}
