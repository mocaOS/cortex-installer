import { banner, noteBox, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { ps } from "../docker.js";
import { resolveInstall, formatStatusTable } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir, state } = resolveInstall(ctx.flags);
  const rows = await ps(dir);
  noteBox(`Cortex ${state.stack} · ${state.mode} · ${dir}`,
    rows.length ? formatStatusTable(rows, state) : ["no containers — run `cortex start`"]);
  p.outro("");
}
