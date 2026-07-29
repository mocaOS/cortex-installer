import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveChat, readEffectiveChat } from "../src/chat.js";
import { ensureChatProfile } from "../src/update.js";

// --- Fix round 2: the single reconciliation, used by both `update` and
// `start`. ---
//
// These tests moved here from test/update.test.ts because the decision
// itself now lives in src/chat.ts, not commands/update.ts: `start` needed the
// exact same rule and had none of it, only ever reading cortex.json via
// chatEnabledFor(state). That gap meant the documented disable path —
// comment COMPOSE_PROFILES=chat in .env, run `restart` (stop, then start) —
// made `start` watch for a chat container Compose was never asked to create:
// a 300-second timeout ending in a false "Timed out waiting for health" on a
// stack that is actually fine, immediately after following the README.
//
// The rule itself is unchanged from Fix round 1: `envMentionsChatProfile(env)
// ? envHasChatProfile(env) : chatEnabledFor(state)`. These tests call
// effectiveChat directly rather than re-deriving that expression by hand, so
// a future edit to the real function cannot silently drift from what the
// tests believe it does — which is exactly the class of bug (two independent
// copies of "the same" logic, one never updated) that made both Fix round 1
// and this round necessary in the first place.

test("effectiveChat: an active chat profile in .env overrides a stale state.chat=false", () => {
  const state = { chat: false };
  const envText = "COMPOSE_FILE=a.yml\nCOMPOSE_PROFILES=chat\nNEO4J_PASSWORD=s3cret\n";

  const chat = effectiveChat(envText, state);
  assert.equal(chat, true, "an active chat profile in .env must win over a stale false in cortex.json");

  // Persisting `chat` (not state.chat) to cortex.json is what corrects the
  // stale false to true; here it must also leave the already-active line alone.
  assert.match(ensureChatProfile(envText, chat), /^COMPOSE_PROFILES=chat$/m);
});

test("effectiveChat: a quoted active chat profile in .env also overrides a stale state.chat=false", () => {
  const state = { chat: false };
  const envText = 'COMPOSE_PROFILES="chat"\nNEO4J_PASSWORD=s3cret\n';
  assert.equal(
    effectiveChat(envText, state),
    true,
    "a quoted active profile must be recognized too, not just the unquoted form"
  );
});

test("effectiveChat: state.chat=true restores a profile line missing from .env entirely", () => {
  const state = { chat: true };
  const envText = "COMPOSE_FILE=a.yml\nNEO4J_PASSWORD=s3cret\n"; // no COMPOSE_PROFILES line at all

  const chat = effectiveChat(envText, state);
  assert.equal(chat, true);
  assert.match(ensureChatProfile(envText, chat), /^COMPOSE_PROFILES=chat$/m);
});

test("effectiveChat: an operator commenting the profile out by hand overrides a stale state.chat=true", () => {
  // This is the Fix round 1 Critical: the old `chatEnabledFor(state) ||
  // envHasChatProfile(envText)` gave `true` here (OR cannot produce `false`
  // once state.chat is `true`), which made ensureChatProfile RESTORE the very
  // line the operator had just commented out, exactly reversing the documented
  // instruction and silently turning chat back on.
  const state = { chat: true };
  const envText = "COMPOSE_FILE=a.yml\n# COMPOSE_PROFILES=chat\nNEO4J_PASSWORD=s3cret\n";

  const chat = effectiveChat(envText, state);
  assert.equal(chat, false, "a commented profile line in .env must win over a stale true in cortex.json");

  // Persisting `chat` (not state.chat) to cortex.json is what corrects the
  // stale true to false; here it must also leave the already-commented line
  // alone rather than "restoring" it.
  const out = ensureChatProfile(envText, chat);
  assert.equal(out, envText, "already-off must be a byte-for-byte no-op, not a restore");
  assert.match(out, /^# COMPOSE_PROFILES=chat$/m);
});

test("effectiveChat: a pre-migration install falls back to state and chat stays on (the Task 9 migration)", () => {
  // A .env written by an installer <=1.1.0 has no COMPOSE_PROFILES line
  // whatsoever — active or commented — because the variable did not exist
  // yet. This is the one case that must never break.
  const state = {}; // no `chat` field at all: this install predates the option
  const envText = "COMPOSE_FILE=docker-compose.yml:docker-compose.ports.yml\nNEO4J_PASSWORD=s3cret\n";

  const chat = effectiveChat(envText, state);
  assert.equal(chat, true, "absent state.chat plus no .env line at all must still mean chat stays on");
  assert.match(ensureChatProfile(envText, chat), /^COMPOSE_PROFILES=chat$/m);
});

// --- Fix round 2: readEffectiveChat must tolerate a missing/unreadable .env. ---
// `start` runs against whatever is actually on disk, including a half-broken
// install. Crashing on a file error instead of trying to start the stack
// would be a worse outcome than the health-wait bug this whole round fixes.

test("readEffectiveChat falls back to chatEnabledFor(state) when .env does not exist at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  // No .env written — a fresh temp dir has nothing in it.
  assert.equal(readEffectiveChat(dir, { chat: false }), false);
  assert.equal(readEffectiveChat(dir, { chat: true }), true);
  assert.equal(readEffectiveChat(dir, {}), true, "absent state.chat must still mean chat stays on");
});

test("readEffectiveChat falls back to chatEnabledFor(state) when .env exists but cannot be read as a file", () => {
  // A directory in .env's place makes readFileSync throw EISDIR — deterministic
  // on every platform and every user (unlike chmod 0o000, which a process
  // running as root simply ignores), so this reliably exercises the catch
  // branch rather than the happy path.
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  mkdirSync(join(dir, ".env"));
  assert.equal(readEffectiveChat(dir, { chat: false }), false);
  assert.equal(readEffectiveChat(dir, { chat: true }), true);
});

test("readEffectiveChat reads a real .env from disk and reconciles exactly like effectiveChat", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  writeFileSync(join(dir, ".env"), "# COMPOSE_PROFILES=chat\n");
  assert.equal(
    readEffectiveChat(dir, { chat: true }),
    false,
    ".env must win over a stale state.chat=true, exactly like effectiveChat"
  );
});
