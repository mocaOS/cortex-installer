import { test } from "node:test";
import assert from "node:assert/strict";
import { diffComponents, rewriteImagePins, ensureChatProfile } from "../src/update.js";

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
