import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchArtifacts, ARTIFACT_FILES } from "../src/artifacts.js";

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

// Hits the real release. Skipped only when the network is genuinely unavailable.
test("fetches every artifact the stack needs from a real release tag", async (t) => {
  if (!(await githubReachable())) {
    return t.skip("network unavailable: could not reach github.com");
  }

  const dir = mkdtempSync(join(tmpdir(), "art-"));
  // Deliberately NOT wrapped: any rejection from here on is a real failure.
  await fetchArtifacts({ version: "1.0.0", dir });

  for (const f of ARTIFACT_FILES) {
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
  await assert.rejects(fetchArtifacts({ version: "0.0.0-nope", dir }), /404|not found/i);
});
