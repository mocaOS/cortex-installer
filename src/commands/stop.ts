import { banner, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { down } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir } = resolveInstall(ctx.flags);
  const s = p.spinner();
  s.start("Stopping");
  // No -v: volumes are the user's data and are never removed by `stop`.
  await down(dir, false);
  s.stop("Stopped — your data volumes are untouched");
  p.outro("");
}
