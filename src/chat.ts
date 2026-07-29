import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envHasChatProfile, envMentionsChatProfile } from "./update.js";
import { chatEnabledFor } from "./state.js";

/**
 * The single answer to "is chat installed right now", reconciling
 * cortex.json against .env exactly as established in Fix round 1: once .env
 * has anything to say about the profile at all — an active line, whatever it
 * lists, or the exact commented form this codebase writes when chat is
 * declined — it is authoritative over cortex.json, in BOTH directions.
 * cortex.json is consulted only when .env is silent on the matter entirely,
 * which is what the pre-1.2.0 migration (Task 7/9: an absent state.chat
 * means chat stays on) depends on. See envMentionsChatProfile's doc comment
 * in update.ts for the full quote/comment-normalization rationale, and
 * envHasChatProfile's for why the active case needs the same normalization.
 *
 * Fix round 2: before this extraction, the rule was re-derived independently
 * in commands/update.ts and NOT AT ALL in commands/start.ts, which only ever
 * consulted chatEnabledFor(state). That gap meant the exact documented
 * disable path — comment COMPOSE_PROFILES=chat in .env, run
 * `npx @mocaos/cortex restart` (stop, then start) — made `start` tell
 * waitHealthy to watch for a `chat` container Compose was never asked to
 * create: healthServices' own doc comment names this failure mode precisely
 * — a full-timeout spin ending in a false failure. In practice: a 300-second
 * hang and "Timed out waiting for health" on a stack that is actually fine,
 * immediately after following the README. Centralizing the decision here,
 * with both commands calling it, is what keeps them from drifting apart
 * again the way `update` and `start` already had.
 */
export function effectiveChat(envText: string, state: { chat?: boolean }): boolean {
  return envMentionsChatProfile(envText) ? envHasChatProfile(envText) : chatEnabledFor(state);
}

/**
 * Same rule, tolerant of a missing or unreadable .env.
 *
 * This is what `start` calls: unlike `update`, it does not already have .env
 * open in memory for another reason, so it has to read it fresh from `dir`.
 * A half-broken install — .env deleted, permissions mangled, `dir` pointing
 * somewhere odd — must still let `start` try to bring the stack up; crashing
 * on a file error before Compose even runs would be worse than the health-wait
 * bug this function exists to fix. On any read failure this falls back to
 * chatEnabledFor(state), the same fallback effectiveChat itself uses when
 * .env is readable but silent on the matter.
 */
export function readEffectiveChat(dir: string, state: { chat?: boolean }): boolean {
  try {
    return effectiveChat(readFileSync(join(dir, ".env"), "utf8"), state);
  } catch {
    return chatEnabledFor(state);
  }
}
