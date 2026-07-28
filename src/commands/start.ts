import { banner, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { up, waitHealthy } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir } = resolveInstall(ctx.flags);
  const s = p.spinner();
  s.start("Starting");
  await up(dir);
  s.stop("Started");
  s.start("Waiting for health");
  const ok = await waitHealthy(dir, ["neo4j", "backend", "frontend", "chat"]);
  s.stop(ok ? "Healthy" : "Timed out — check `cortex logs`");
  p.outro("");
}
