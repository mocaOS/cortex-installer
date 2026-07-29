import { test } from "node:test";
import assert from "node:assert/strict";
import { diffComponents, rewriteImagePins, ensureChatProfile, envHasChatProfile } from "../src/update.js";
import { chatEnabledFor } from "../src/state.js";

const from = { backend: "1.0.0", frontend: "1.0.0", chat: "1.0.0", neo4j: "5.26-community", caddy: "2-alpine" };

test("marks only the components that actually moved", () => {
  const d = diffComponents(from, { ...from, chat: "1.0.1" });
  assert.equal(d.find((x) => x.name === "chat")!.changed, true);
  assert.equal(d.find((x) => x.name === "backend")!.changed, false);
});

test("reports every component, changed or not", () => {
  assert.equal(diffComponents(from, from).length, 5);
});

test("an identical stack yields no changes", () => {
  assert.equal(diffComponents(from, from).every((x) => !x.changed), true);
});

test("rewrites only the image pin lines and preserves everything else", () => {
  const env = [
    "# a comment the user added",
    "COMPOSE_FILE=docker-compose.yml:docker-compose.ports.yml",
    "CORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:1.0.0",
    "CORTEX_FRONTEND_IMAGE=ghcr.io/mocaos/cortex-frontend:1.0.0",
    "CORTEX_CHAT_IMAGE=ghcr.io/mocaos/cortex-chat:1.0.0",
    "NEO4J_VERSION=5.26-community",
    "CADDY_VERSION=2-alpine",
    "MY_CUSTOM_TWEAK=keep-me",
    "",
  ].join("\n");

  const out = rewriteImagePins(env, { ...from, backend: "1.1.0", chat: "1.0.1" });

  assert.match(out, /^CORTEX_BACKEND_IMAGE=ghcr\.io\/mocaos\/cortex-backend:1\.1\.0$/m);
  assert.match(out, /^CORTEX_CHAT_IMAGE=ghcr\.io\/mocaos\/cortex-chat:1\.0\.1$/m);
  assert.match(out, /^CORTEX_FRONTEND_IMAGE=ghcr\.io\/mocaos\/cortex-frontend:1\.0\.0$/m);
  assert.match(out, /^MY_CUSTOM_TWEAK=keep-me$/m);
  assert.match(out, /^# a comment the user added$/m);
});

test("rewriting is idempotent", () => {
  const env = "CORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:1.0.0\n";
  const once = rewriteImagePins(env, from);
  assert.equal(rewriteImagePins(once, from), once);
});

test("does not touch a secret that happens to contain an image-like string", () => {
  const env = "ADMIN_API_KEY=cortex_admin_deadbeef\nCORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:1.0.0\n";
  const out = rewriteImagePins(env, { ...from, backend: "2.0.0" });
  assert.match(out, /^ADMIN_API_KEY=cortex_admin_deadbeef$/m);
});

test("rewrites an indented pin line instead of silently skipping it", () => {
  const env = "  CORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:1.0.0\n";
  const out = rewriteImagePins(env, { ...from, backend: "2.0.0" });
  assert.match(out, /CORTEX_BACKEND_IMAGE=ghcr\.io\/mocaos\/cortex-backend:2\.0\.0/);
});

test("preserves CRLF line endings on a rewritten pin line", () => {
  const env = "CORTEX_BACKEND_IMAGE=ghcr.io/mocaos/cortex-backend:1.0.0\r\nMY_CUSTOM_TWEAK=keep-me\r\n";
  const out = rewriteImagePins(env, { ...from, backend: "2.0.0" });
  assert.match(out, /^CORTEX_BACKEND_IMAGE=ghcr\.io\/mocaos\/cortex-backend:2\.0\.0\r$/m);
  assert.match(out, /^MY_CUSTOM_TWEAK=keep-me\r$/m);
});

test("leaves a near-miss key alone instead of matching it as a prefix", () => {
  const env = "CORTEX_BACKEND_IMAGE_X=something-unrelated\n";
  const out = rewriteImagePins(env, { ...from, backend: "2.0.0" });
  assert.match(out, /^CORTEX_BACKEND_IMAGE_X=something-unrelated$/m);
});

test("ensureChatProfile adds the profile line when it is absent", () => {
  const out = ensureChatProfile("COMPOSE_FILE=a.yml\nCOMPOSE_PROJECT_NAME=cortex\n", true);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
});

test("ensureChatProfile uncomments the commented form rather than duplicating it", () => {
  const out = ensureChatProfile("# COMPOSE_PROFILES=chat\nCOMPOSE_FILE=a.yml\n", true);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
  assert.equal(out.match(/COMPOSE_PROFILES=chat/g)?.length, 1);
});

test("ensureChatProfile is idempotent", () => {
  const once = ensureChatProfile("COMPOSE_PROFILES=chat\n", true);
  assert.equal(ensureChatProfile(once, true), once);
});

test("ensureChatProfile comments the line out when disabling", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES=chat\nCOMPOSE_FILE=a.yml\n", false);
  assert.ok(!/^COMPOSE_PROFILES=chat$/m.test(out));
  assert.match(out, /^# COMPOSE_PROFILES=chat$/m);
});

test("disabling when no profile line exists is a byte-for-byte no-op", () => {
  // This function rewrites the file holding the only copy of NEO4J_PASSWORD, so
  // it must never touch a line it was not asked to change.
  const input = "NEO4J_PASSWORD=s3cret\nCOMPOSE_FILE=a.yml\nOPENAI_API_KEY=k\n";
  assert.equal(ensureChatProfile(input, false), input);
});

test("enabling changes exactly one line and preserves the rest", () => {
  const input = "NEO4J_PASSWORD=s3cret\n# COMPOSE_PROFILES=chat\nOPENAI_API_KEY=k\n";
  const out = ensureChatProfile(input, true);
  assert.equal(out.split("\n").length, input.split("\n").length, "line count must not change");
  assert.match(out, /^NEO4J_PASSWORD=s3cret$/m);
  assert.match(out, /^OPENAI_API_KEY=k$/m);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
});

// --- Fix round 2, Important 2: an operator's other profiles must survive. ---
// COMPOSE_PROFILES is a comma list, not a chat-only switch: the installer's own
// header blesses docker-compose.override.yml for an operator's own
// profile-gated add-ons, and those commonly share this line with chat.

test("ensureChatProfile appends chat to an existing profile list without disturbing it", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES=debug\nCOMPOSE_FILE=a.yml\n", true);
  assert.match(out, /^COMPOSE_PROFILES=debug,chat$/m);
});

test("ensureChatProfile removes only chat from a multi-value list, keeping the rest active", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES=chat,myextra\nCOMPOSE_FILE=a.yml\n", false);
  assert.match(out, /^COMPOSE_PROFILES=myextra$/m);
  assert.ok(
    !/^#\s*COMPOSE_PROFILES/m.test(out),
    "a list with a remaining entry must stay active, not get commented out"
  );
});

test("ensureChatProfile leaves an unrelated profile list untouched when chat was never in it", () => {
  const input = "COMPOSE_PROFILES=myextra\nCOMPOSE_FILE=a.yml\n";
  assert.equal(ensureChatProfile(input, false), input);
});

test("ensureChatProfile is idempotent on a multi-value list", () => {
  const once = ensureChatProfile("COMPOSE_PROFILES=debug,chat\n", true);
  assert.equal(once, "COMPOSE_PROFILES=debug,chat\n", "already-present chat must not be reformatted");
  assert.equal(ensureChatProfile(once, true), once);
});

// --- Fix round 2, Important 1: .env and cortex.json must reconcile both ways. ---
// state.chat can go stale in either direction: the installer's own documented
// route for declining chat tells the operator to hand-edit .env directly and
// never touches cortex.json (see the "NOT installed" blocks in renderEnv,
// env.ts). commands/update.ts derives the effective value as
// `chatEnabledFor(state) || envHasChatProfile(envText)` — these tests cover
// envHasChatProfile itself and that exact composed expression.

test("envHasChatProfile is true when chat is one of several active profiles", () => {
  assert.equal(envHasChatProfile("COMPOSE_PROFILES=debug,chat\n"), true);
});

test("envHasChatProfile is false when the profile line is only commented out", () => {
  assert.equal(envHasChatProfile("# COMPOSE_PROFILES=chat\n"), false);
});

test("envHasChatProfile is false when there is no profile line at all", () => {
  assert.equal(envHasChatProfile("COMPOSE_FILE=a.yml\n"), false);
});

test("reconciliation: an active chat profile in .env overrides a stale state.chat=false", () => {
  const state = { chat: false };
  const envText = "COMPOSE_FILE=a.yml\nCOMPOSE_PROFILES=chat\nNEO4J_PASSWORD=s3cret\n";

  // The exact expression commands/update.ts uses to derive the effective value
  // before back-filling both .env and cortex.json.
  const chat = chatEnabledFor(state) || envHasChatProfile(envText);
  assert.equal(chat, true, "an active chat profile in .env must win over a stale false in cortex.json");

  // Persisting `chat` (not state.chat) to cortex.json is what corrects the
  // stale false to true; here it must also leave the already-active line alone.
  assert.match(ensureChatProfile(envText, chat), /^COMPOSE_PROFILES=chat$/m);
});

test("reconciliation: state.chat=true restores a profile line missing from .env entirely", () => {
  const state = { chat: true };
  const envText = "COMPOSE_FILE=a.yml\nNEO4J_PASSWORD=s3cret\n"; // no COMPOSE_PROFILES line at all

  const chat = chatEnabledFor(state) || envHasChatProfile(envText);
  assert.equal(chat, true);
  assert.match(ensureChatProfile(envText, chat), /^COMPOSE_PROFILES=chat$/m);
});

test("reconciliation: state.chat=true restores a profile line an operator commented out by hand", () => {
  const state = { chat: true };
  const envText = "COMPOSE_FILE=a.yml\n# COMPOSE_PROFILES=chat\nNEO4J_PASSWORD=s3cret\n";

  const chat = chatEnabledFor(state) || envHasChatProfile(envText);
  assert.equal(chat, true);
  const out = ensureChatProfile(envText, chat);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
  assert.equal(out.split("\n").length, envText.split("\n").length, "line count must not change");
});
