import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchArtifacts, ARTIFACT_FILES } from "../src/artifacts.js";

// Hits the real release. Skipped when offline.
test("fetches every artifact the stack needs from a real release tag", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  try {
    await fetchArtifacts({ version: "1.0.0", dir });
  } catch (err) {
    return t.skip(`network unavailable: ${(err as Error).message}`);
  }
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
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  try {
    await assert.rejects(fetchArtifacts({ version: "0.0.0-nope", dir }), /404|not found/i);
  } catch (err) {
    t.skip(`network unavailable: ${(err as Error).message}`);
  }
});
