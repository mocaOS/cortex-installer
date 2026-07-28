import { logs } from "../docker.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: {
  flags: Record<string, string | boolean>;
  positionals: string[];
}): Promise<void> {
  const { dir } = resolveInstall(ctx.flags);
  process.exitCode = await logs(dir, ctx.positionals[0]);
}
