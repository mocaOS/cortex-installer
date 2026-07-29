import { banner, prompts as p } from "../ui.js";
import { installerVersion } from "../version.js";
import { up, waitHealthy, healthServices } from "../docker.js";
import { readEffectiveChat } from "../chat.js";
import { resolveInstall } from "./_shared.js";

export async function run(ctx: { flags: Record<string, string | boolean> }): Promise<void> {
  banner(installerVersion());
  const { dir, state } = resolveInstall(ctx.flags);
  const s = p.spinner();
  s.start("Starting");
  await up(dir);
  s.stop("Started");
  s.start("Waiting for health");
  // state.mode decides whether caddy is part of the stack. Chat used to come
  // from chatEnabledFor(state) alone, which only ever reads cortex.json — so
  // the documented disable path (comment COMPOSE_PROFILES=chat, then
  // `restart`, which is stop+start) made this watch for a chat container
  // Compose was never asked to create: a 300s timeout ending in a false
  // "Timed out" on a stack that is actually fine. readEffectiveChat (see
  // chat.ts) consults .env too, with the same reconciliation `update` uses,
  // and tolerates a missing/unreadable .env by falling back to state instead
  // of throwing — `start` should still try on a half-broken install.
  const ok = await waitHealthy(dir, healthServices(state.mode, readEffectiveChat(dir, state)));
  s.stop(ok ? "Healthy" : "Timed out — check `cortex logs`");
  p.outro("");
}
