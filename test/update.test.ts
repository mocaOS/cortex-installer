import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffComponents,
  rewriteImagePins,
  ensureChatProfile,
  envHasChatProfile,
  envMentionsChatProfile,
} from "../src/update.js";

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
// route for adding OR declining chat tells the operator to hand-edit .env
// directly and never touches cortex.json (see the "NOT installed" blocks in
// renderEnv, env.ts, and the top-level README).
//
// The composed reconciliation itself — effectiveChat — moved to src/chat.ts
// in Fix round 2, once `start` turned out to need the exact same decision and
// had none of it (see chat.ts's doc comment for that story). Its tests moved
// with it, to test/chat.test.ts. These two groups here cover just the two
// .env predicates in isolation, which still live in this file.

test("envHasChatProfile is true when chat is one of several active profiles", () => {
  assert.equal(envHasChatProfile("COMPOSE_PROFILES=debug,chat\n"), true);
});

test("envHasChatProfile is false when the profile line is only commented out", () => {
  assert.equal(envHasChatProfile("# COMPOSE_PROFILES=chat\n"), false);
});

test("envHasChatProfile is false when there is no profile line at all", () => {
  assert.equal(envHasChatProfile("COMPOSE_FILE=a.yml\n"), false);
});

test("envMentionsChatProfile is true for an active COMPOSE_PROFILES line, whatever it lists", () => {
  assert.equal(envMentionsChatProfile("COMPOSE_PROFILES=debug\n"), true);
});

test("envMentionsChatProfile is true for the commented chat-only form the installer and update both write", () => {
  assert.equal(envMentionsChatProfile("# COMPOSE_PROFILES=chat\n"), true);
});

test("envMentionsChatProfile is false when there is no COMPOSE_PROFILES line in any form", () => {
  assert.equal(envMentionsChatProfile("COMPOSE_FILE=a.yml\nNEO4J_PASSWORD=s3cret\n"), false);
});

// --- Fix round 3: list editing must agree with Compose's own .env parser. ---
// Compose unquotes a wrapped value and strips an unquoted trailing `#` comment
// before it ever sees a comma. Splitting the raw text instead meant a quoted
// or commented value disagreed with what Compose actually reads — and once
// list-editing existed (round 2), that disagreement turned into damage:
// writing unparseable syntax, silently failing to add chat, or silently
// failing to remove it. All three are covered below, plus the "current
// install already includes chat" checks needed the same normalization.

test("ensureChatProfile normalizes a quoted profile list and recognizes chat already in it", () => {
  // COMPOSE_PROFILES="chat,myextra" is a working, chat-running install. Naive
  // comma-splitting of the raw text yields the bogus entries `"chat` and
  // `myextra"`, so a naive "is chat already there" check fails and enabling
  // appends a second, unparseable `,chat` outside the closing quote.
  const out = ensureChatProfile('COMPOSE_PROFILES="chat,myextra"\n', true);
  assert.match(out, /^COMPOSE_PROFILES=chat,myextra$/m);
  assert.ok(!out.includes('"'), "the rewritten line must not still be quoted");
});

test("ensureChatProfile treats a single-quoted value the same as a double-quoted one", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES='chat,myextra'\n", true);
  assert.match(out, /^COMPOSE_PROFILES=chat,myextra$/m);
});

test("ensureChatProfile strips an inline comment before deciding chat is absent, so it actually gets added", () => {
  // Compose strips from an unquoted `#` onward, reading only `myextra` here.
  // Splitting the raw text instead treats "myextra # note" as one opaque
  // entry, so chat looks absent, gets appended AFTER the comment, and Compose
  // never sees it: the update reports success while chat never starts.
  const out = ensureChatProfile("COMPOSE_PROFILES=myextra # note\n", true);
  assert.match(out, /^COMPOSE_PROFILES=myextra,chat$/m);
});

test("ensureChatProfile disables a quoted chat-only value by commenting the line out", () => {
  const out = ensureChatProfile('COMPOSE_PROFILES="chat"\n', false);
  assert.match(out, /^# COMPOSE_PROFILES=chat$/m);
  assert.ok(!/^COMPOSE_PROFILES=/m.test(out), "must not remain active");
});

test("ensureChatProfile disables a chat-only value with a trailing comment by commenting the line out", () => {
  // Without normalization, "chat # keep" never string-equals "chat", so the
  // disable guard sees no chat entry to remove and leaves the line active —
  // Compose keeps starting chat while cortex.json now says it is off.
  const out = ensureChatProfile("COMPOSE_PROFILES=chat # keep\n", false);
  assert.match(out, /^# COMPOSE_PROFILES=chat$/m);
});

test("envHasChatProfile recognizes a quoted chat-only value", () => {
  assert.equal(envHasChatProfile('COMPOSE_PROFILES="chat"'), true);
});

test("a # inside a quoted value is part of the value, not a comment, so trailing entries still parse", () => {
  // chat comes AFTER the embedded #, so if comment-stripping over-reached into
  // a quoted value, this would wrongly come back false.
  assert.equal(envHasChatProfile('COMPOSE_PROFILES="my#extra,chat"'), true);
});

// The quoted-value reconciliation case ("a quoted active chat profile in .env
// also overrides a stale state.chat=false") moved to test/chat.test.ts along
// with the rest of the effectiveChat tests — see the comment above.

// --- Fix round 4: quoted AND commented is a composition, not a third case. ---
// Round 3 treated "wrapped in quotes" and "has a trailing comment" as mutually
// exclusive: the wrapped-value check required the closing quote to be the
// LAST character, so `"chat" # note` failed it, fell into the unquoted
// branch, and got cut at the first `#` — leaving the quote characters
// attached (`"chat"`, not `chat`). That string never equals "chat", so this
// was the exact same failure mode as round 3's symptom (a)/(c) all over
// again: enabling appended a second, unparseable `,chat` outside the quotes;
// disabling silently no-opped. The fix locates the closing quote by scanning
// for it instead of requiring it to be the string's last character.

test("ensureChatProfile normalizes a quoted value with a trailing comment (enable)", () => {
  const out = ensureChatProfile('COMPOSE_PROFILES="chat" # note\n', true);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
  assert.ok(!out.includes('"'), "must not still be quoted");
});

test("ensureChatProfile normalizes a quoted value with a trailing comment (disable)", () => {
  const out = ensureChatProfile('COMPOSE_PROFILES="chat" # note\n', false);
  assert.match(out, /^# COMPOSE_PROFILES=chat$/m);
  assert.ok(!/^COMPOSE_PROFILES=/m.test(out), "must not remain active");
});

test("ensureChatProfile normalizes a quoted multi-value list with a trailing comment", () => {
  // This is the exact input the coordinator traced through the old code to
  // `COMPOSE_PROFILES="chat,myextra",chat` — the same unparseable shape round
  // 3 already fixed for the no-comment case.
  const out = ensureChatProfile('COMPOSE_PROFILES="chat,myextra" # note\n', true);
  assert.match(out, /^COMPOSE_PROFILES=chat,myextra$/m);
  assert.ok(!out.includes('"'), "must not still be quoted");
});

test("ensureChatProfile normalizes a single-quoted value with a trailing comment", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES='chat' # note\n", true);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
});

test("ensureChatProfile normalizes a quoted value whose comment has no leading space", () => {
  const out = ensureChatProfile('COMPOSE_PROFILES="chat"# note\n', true);
  assert.match(out, /^COMPOSE_PROFILES=chat$/m);
});

test("chat#x with no trailing comment still yields the single entry chat#x, not chat", () => {
  // Guards the closing-quote search itself: it must stop at the FIRST
  // matching quote character. If it instead kept treating an inner `#` as a
  // comment start, this would come back as just "chat" instead of the
  // distinct profile "chat#x", and chat would be wrongly considered already
  // present instead of getting appended.
  const out = ensureChatProfile('COMPOSE_PROFILES="chat#x"\n', true);
  assert.match(out, /^COMPOSE_PROFILES=chat#x,chat$/m);
});
