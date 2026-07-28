import { run as stop } from "./stop.js";
import { run as start } from "./start.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  await stop(ctx);
  await start(ctx);
}
