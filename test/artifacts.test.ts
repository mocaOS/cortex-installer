import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchArtifacts, ARTIFACT_FILES, caddyTemplateFor, requiredArtifactFiles } from "../src/artifacts.js";
import { CHAT_OPTIONAL_SINCE } from "../src/stack.js";

/**
 * Decides reachability INDEPENDENTLY of the call under test, the same way the
 * 404 test below does.
 *
 * Wrapping fetchArtifacts itself in try/catch and skipping on any rejection
 * turned this test — the only one that exercises the real tarball end to end —
 * into something that could never fail. It reported a green skip for genuine
 * bugs: a missing artifact, a bad URL, and in particular the GNU-tar wildcard
 * incompatibility that extracted nothing on Linux, which was this plan's
 * highest-value catch and would have been silently swallowed here.
 */
async function githubReachable(): Promise<boolean> {
  try {
    const res = await fetch("https://github.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * The artifact set release v1.0.0 (the fixed tag this test downloads) actually
 * shipped in its selfhost/ directory — deliberately NOT the live ARTIFACT_FILES
 * export.
 *
 * A pinned historical release and the current artifact contract drift apart by
 * construction: every future addition to ARTIFACT_FILES (this task's own
 * Caddyfile.chat.template, first) describes what a NEW release must contain,
 * and v1.0.0 predates it and always will — tags don't grow files after the
 * fact. Asserting the live export here would fail this test on every such
 * addition until a new release ships, which is a false failure unrelated to
 * the thing this test actually verifies: that the real download-and-extract
 * pipeline works end to end (this is how the GNU-tar wildcard incompatibility
 * was caught). The live contract is covered separately, by "both Caddyfile
 * templates are required artifacts" below.
 */
const V1_0_0_ARTIFACTS = [
  "docker-compose.yml",
  "docker-compose.ports.yml",
  "docker-compose.caddy.yml",
  "Caddyfile.template",
  ".env.example",
] as const;

// Hits the real release. Skipped only when the network is genuinely unavailable.
test("fetches every artifact the stack needs from a real release tag", async (t) => {
  if (!(await githubReachable())) {
    return t.skip("network unavailable: could not reach github.com");
  }

  const dir = mkdtempSync(join(tmpdir(), "art-"));
  // Deliberately NOT wrapped: any rejection from here on is a real failure.
  // chat: false so the Caddyfile comparison below is against Caddyfile.template,
  // the artifact this test actually names.
  await fetchArtifacts({ version: "1.0.0", dir, chat: false });

  for (const f of V1_0_0_ARTIFACTS) {
    assert.ok(existsSync(join(dir, f)), `missing ${f}`);
  }
  assert.ok(existsSync(join(dir, "ops", "backup", "backup.sh")), "missing ops/backup/backup.sh");
  // Caddyfile must be a real copy, not left as a template only.
  assert.ok(existsSync(join(dir, "Caddyfile")), "Caddyfile was not created from the template");
  assert.equal(
    readFileSync(join(dir, "Caddyfile"), "utf8"),
    readFileSync(join(dir, "Caddyfile.template"), "utf8")
  );
});

test("rejects a version that has no release", async (t) => {
  // Reachability is decided independently of the assertion below, so that a
  // rejection message which stopped matching /404|not found/i fails this test
  // instead of being swallowed as "offline". (Now checks github.com, the host
  // fetchArtifacts actually downloads from — codeload rather than the
  // rate-limited api.github.com.)
  if (!(await githubReachable())) {
    return t.skip("network unavailable: could not reach github.com");
  }

  const dir = mkdtempSync(join(tmpdir(), "art-"));
  await assert.rejects(fetchArtifacts({ version: "0.0.0-nope", dir, chat: false }), /404|not found/i);
});

test("both Caddyfile templates are required artifacts", () => {
  // A release missing one must fail loudly during the fetch, not later as Caddy
  // crash-looping on a bind mount Docker turned into a directory.
  const files = ARTIFACT_FILES as readonly string[];
  assert.ok(files.includes("Caddyfile.template"));
  assert.ok(files.includes("Caddyfile.chat.template"));
});

// --- version-gated Caddyfile template selection -----------------------------
// caddyTemplateFor and requiredArtifactFiles are exactly what fetchArtifacts
// itself calls to decide what to copy and what to require. Asserted directly
// here, no network involved, the same way DOWN_ENV/UP_ARGS are asserted in
// docker.test.ts, so the pre-CHAT_OPTIONAL_SINCE path can't regress silently:
// it previously sent cpSync after a Caddyfile.chat.template that a real old
// release (v1.0.0) does not have, which threw ENOENT rather than the
// intended "is missing selfhost/..." message — confirmed against the real
// release before this fix existed.

test("caddyTemplateFor copies the single pre-split template regardless of chat, on a release older than CHAT_OPTIONAL_SINCE", () => {
  // supportsOptionalChat() (stack.ts) forces chat: true for exactly these
  // releases — their compose has no profile to switch chat off with — so
  // chat: true reaching here for an old release is the normal case, not an
  // edge case, and must still resolve to the one template that release has.
  assert.equal(caddyTemplateFor("1.0.0", false), "Caddyfile.template");
  assert.equal(caddyTemplateFor("1.0.0", true), "Caddyfile.template");
});

test("caddyTemplateFor chooses between the two templates from CHAT_OPTIONAL_SINCE onward", () => {
  assert.equal(caddyTemplateFor(CHAT_OPTIONAL_SINCE, false), "Caddyfile.template");
  assert.equal(caddyTemplateFor(CHAT_OPTIONAL_SINCE, true), "Caddyfile.chat.template");
  assert.equal(caddyTemplateFor("2.0.0", true), "Caddyfile.chat.template");
});

test("requiredArtifactFiles excludes Caddyfile.chat.template before CHAT_OPTIONAL_SINCE", () => {
  // v1.0.0 genuinely does not contain this file; requiring it would fail
  // every pinned old-stack install, in both chat states.
  const files = requiredArtifactFiles("1.0.0");
  assert.ok(files.includes("Caddyfile.template"));
  assert.ok(!files.includes("Caddyfile.chat.template"), "v1.0.0 never shipped this file");
});

test("requiredArtifactFiles requires both templates from CHAT_OPTIONAL_SINCE onward", () => {
  const files = requiredArtifactFiles(CHAT_OPTIONAL_SINCE);
  assert.ok(files.includes("Caddyfile.template"));
  assert.ok(files.includes("Caddyfile.chat.template"));
});
