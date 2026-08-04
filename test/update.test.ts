import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffComponents,
  rewriteImagePins,
  ensureChatProfile,
  envHasChatProfile,
  envMentionsChatProfile,
  envHasChatDomain,
} from "../src/update.js";
import { assertChatDomainConfigured, handleComposeGuardFailure } from "../src/commands/update.js";

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

// --- Final review Fix 2: first-match vs last-wins. --------------------------
// Compose's own dotenv parser is last-wins on a duplicate key (verified
// against real `docker compose config --services` with two COMPOSE_PROFILES
// lines). Reading the FIRST line instead — the old .find/findIndex — produced
// two verified-live symptoms: "chat" then "myextra" made the installer believe
// chat was on while Compose ran only myextra (waitHealthy then spins the full
// 300s on a container Compose never creates, ending in a false "Timed out");
// "myextra" then "chat" made the installer believe chat was off while Compose
// actually ran it (disable no-ops, and in domain mode the app-only Caddyfile
// is installed while the chat container keeps serving).

test("envHasChatProfile honors the LAST active COMPOSE_PROFILES line (chat first, then the winning line drops it)", () => {
  const envText = "COMPOSE_PROFILES=chat\nCOMPOSE_PROFILES=myextra\n";
  assert.equal(envHasChatProfile(envText), false, "myextra is the line Compose actually honors");
});

test("envHasChatProfile honors the LAST active COMPOSE_PROFILES line (chat second, so it wins)", () => {
  const envText = "COMPOSE_PROFILES=myextra\nCOMPOSE_PROFILES=chat\n";
  assert.equal(envHasChatProfile(envText), true, "chat is the line Compose actually honors, not myextra");
});

test("ensureChatProfile edits the LAST active COMPOSE_PROFILES line on enable, leaving the losing first line untouched", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES=myextra\nCOMPOSE_PROFILES=debug\n", true);
  assert.match(out, /^COMPOSE_PROFILES=myextra$/m, "the losing first line must not be touched");
  assert.match(out, /^COMPOSE_PROFILES=debug,chat$/m, "chat must land on the winning last line");
});

test("ensureChatProfile edits the LAST active COMPOSE_PROFILES line on disable, leaving the losing first line untouched", () => {
  const out = ensureChatProfile("COMPOSE_PROFILES=debug\nCOMPOSE_PROFILES=chat,myextra\n", false);
  assert.match(out, /^COMPOSE_PROFILES=debug$/m, "the losing first line must not be touched");
  assert.match(out, /^COMPOSE_PROFILES=myextra$/m, "chat must be removed from the winning last line only");
});

// --- Final review Fix 1: domain mode + chat on must never proceed with an
// empty CHAT_DOMAIN. --------------------------------------------------------
// caddyTemplateFor picks Caddyfile.chat.template from the chat flag alone; an
// empty {$CHAT_DOMAIN} there makes Caddy refuse to adapt the ENTIRE Caddyfile,
// not just the chat site block, and Caddy is the only ingress in domain mode.
// This used to be structurally impossible (${CHAT_DOMAIN:?}); these tests pin
// the replacement guard at the one call site that can reach it silently — an
// operator who uncomments COMPOSE_PROFILES=chat and nothing else.

test("envHasChatDomain is false for a blank, whitespace-only, commented, or absent CHAT_DOMAIN", () => {
  assert.equal(envHasChatDomain(""), false);
  assert.equal(envHasChatDomain("APP_DOMAIN=cortex.example.com\n"), false);
  assert.equal(envHasChatDomain("CHAT_DOMAIN=\n"), false);
  assert.equal(envHasChatDomain("CHAT_DOMAIN=   \n"), false);
  assert.equal(envHasChatDomain("# CHAT_DOMAIN=chat.example.com\n"), false);
});

test("envHasChatDomain is true once an active line assigns real content", () => {
  assert.equal(envHasChatDomain("CHAT_DOMAIN=chat.example.com\n"), true);
});

test("assertChatDomainConfigured aborts when chat resolves on in domain mode with .env holding no CHAT_DOMAIN", () => {
  // Constructed in a real temp dir, not just an in-memory string, so this is
  // the same shape an operator's actual .env would be on disk.
  const dir = mkdtempSync(join(tmpdir(), "chatdomain-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "COMPOSE_PROFILES=chat\nAPP_DOMAIN=cortex.example.com\nACME_EMAIL=ops@example.com\n");
  const envText = readFileSync(envPath, "utf8");

  assert.throws(() => assertChatDomainConfigured(envText, "domain", true), /CHAT_DOMAIN/);
});

test("assertChatDomainConfigured is silent once CHAT_DOMAIN is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "chatdomain-"));
  const envPath = join(dir, ".env");
  writeFileSync(
    envPath,
    "COMPOSE_PROFILES=chat\nAPP_DOMAIN=cortex.example.com\nACME_EMAIL=ops@example.com\nCHAT_DOMAIN=chat.example.com\n"
  );
  const envText = readFileSync(envPath, "utf8");

  assert.doesNotThrow(() => assertChatDomainConfigured(envText, "domain", true));
});

test("assertChatDomainConfigured is silent when chat is off, regardless of CHAT_DOMAIN", () => {
  assert.doesNotThrow(() => assertChatDomainConfigured("APP_DOMAIN=cortex.example.com\n", "domain", false));
});

test("assertChatDomainConfigured is silent in localhost mode, regardless of CHAT_DOMAIN", () => {
  assert.doesNotThrow(() => assertChatDomainConfigured("COMPOSE_PROFILES=chat\n", "localhost", true));
});

// --- Final review Fix 6: a future parser gap must abort safely, not brick the
// install directory. ---------------------------------------------------------
// Three Criticals in this feature's own review came from this installer's
// COMPOSE_PROFILES editing disagreeing with Compose's real dotenv parser. The
// case space is unbounded, so `update` validates the file it just wrote with
// `docker compose config -q` and restores the pre-write .env on failure —
// handleComposeGuardFailure is that restore step. These tests cover the
// restore itself, not the live `docker compose config` call (which the
// installer's own test suite otherwise avoids invoking for real — see
// selfhost/verify-contract.sh in the stack repo for that live coverage).

test("handleComposeGuardFailure restores the pre-write .env to disk before aborting", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const envPath = join(dir, ".env");
  const badText = 'COMPOSE_PROFILES="chat,myextra",chat\n'; // the exact shape Fix round 1 found unparseable
  const goodText = "COMPOSE_PROFILES=chat,myextra\nNEO4J_PASSWORD=s3cret\n";
  writeFileSync(envPath, badText); // simulates the write `update` just made

  assert.throws(() => handleComposeGuardFailure(envPath, goodText, 'unexpected character "," in variable name'));
  assert.equal(readFileSync(envPath, "utf8"), goodText, "the previous .env must be restored to disk, byte for byte");
});

test("handleComposeGuardFailure's error names the operator's own COMPOSE_PROFILES line and Compose's stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "anything\n");
  const envBefore = "NEO4J_PASSWORD=s3cret\nCOMPOSE_PROFILES=chat,myextra\n";

  assert.throws(() => handleComposeGuardFailure(envPath, envBefore, "some compose stderr"), (err: unknown) => {
    const msg = (err as Error).message;
    return msg.includes("COMPOSE_PROFILES=chat,myextra") && msg.includes("some compose stderr");
  });
});

test("handleComposeGuardFailure's error omits the quoted-line section when .env never had a COMPOSE_PROFILES line", () => {
  // The generic "this usually means COMPOSE_PROFILES editing disagreed..."
  // sentence always mentions the word — what must be absent when there is no
  // line to show is the "Your COMPOSE_PROFILES line:" quoting section itself.
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "anything\n");

  assert.throws(() => handleComposeGuardFailure(envPath, "NEO4J_PASSWORD=s3cret\n", "some compose stderr"), (err: unknown) => {
    return !(err as Error).message.includes("Your COMPOSE_PROFILES line");
  });
});
