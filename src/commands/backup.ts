import { banner, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { execIn } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir } = resolveInstall(ctx.flags);
  const s = p.spinner();
  s.start("Running a verified backup");
  try {
    const out = await execIn(dir, "backup", ["/backup.sh"]);
    s.stop("Backup complete");
    p.log.info(out.trim().split("\n").slice(-6).join("\n"));
  } catch (err) {
    s.stop("Backup failed");
    p.log.error(String((err as Error).message).slice(0, 600));
    process.exitCode = 1;
  }
  p.outro("");
}
