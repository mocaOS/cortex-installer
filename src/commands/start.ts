import { banner, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { up, waitHealthy, healthServices } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir, state } = resolveInstall(ctx.flags);
  const s = p.spinner();
  s.start("Starting");
  await up(dir);
  s.stop("Started");
  s.start("Waiting for health");
  // state.mode decides whether caddy is part of the stack — see healthServices.
  const ok = await waitHealthy(dir, healthServices(state.mode));
  s.stop(ok ? "Healthy" : "Timed out — check `cortex logs`");
  p.outro("");
}
