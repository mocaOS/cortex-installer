import { existsSync } from "node:fs";
import { join } from "node:path";
import { banner, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir } = resolveInstall(ctx.flags);
  p.log.info(
    `Settings live in ${join(dir, ".env")}.\n` +
      `  Edit it, then run \`npx @mocaos/cortex restart\`.\n` +
      `  Compose changes belong in docker-compose.override.yml, which updates never touch.`
  );
  if (existsSync(join(dir, ".env.example"))) {
    p.log.info(`Every available variable is documented in ${join(dir, ".env.example")}.`);
  }
  p.outro("");
}
