import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, findInstallDir, type InstallState } from "../src/state.js";

const components = { backend: "1.0.0", frontend: "1.0.0", chat: "1.0.0", neo4j: "5.26-community", caddy: "2-alpine" };

function sample(dir: string): InstallState {
  return {
    installer: "1.0.0", stack: "1.0.0", components,
    mode: "localhost", projectName: "cortex", dir,
    installedAt: "2026-07-28T00:00:00.000Z", providerId: "openai",
    ports: { app: 3000, chat: 3001, api: 8000, neo4jHttp: 7474, neo4jBolt: 7687 },
  };
}

test("round-trips state through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  writeState(dir, sample(dir));
  assert.deepEqual(readState(dir), sample(dir));
});

test("readState returns null when absent", () => {
  assert.equal(readState(mkdtempSync(join(tmpdir(), "st-"))), null);
});

test("readState returns null on malformed JSON rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  writeFileSync(join(dir, "cortex.json"), "{not json");
  assert.equal(readState(dir), null);
});

test("state never carries secret-looking keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  writeState(dir, sample(dir));
  const raw = JSON.stringify(readState(dir));
  for (const k of ["password", "secret", "apiKey", "api_key", "encryptionKey"]) {
    assert.doesNotMatch(raw, new RegExp(k, "i"), `state leaked ${k}`);
  }
});

test("findInstallDir locates cortex.json in the directory itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  writeState(dir, sample(dir));
  assert.equal(findInstallDir(dir), dir);
});

test("findInstallDir walks upwards", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  writeState(dir, sample(dir));
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(findInstallDir(nested), dir);
});

test("findInstallDir returns null when there is no install above", () => {
  assert.equal(findInstallDir(mkdtempSync(join(tmpdir(), "st-"))), null);
});
