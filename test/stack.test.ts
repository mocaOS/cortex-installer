import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStack, assertInstallerSupported, imageRefs, fetchStack } from "../src/stack.js";

const GOOD = {
  stack: "1.0.0",
  components: { backend: "1.0.0", frontend: "1.0.0", chat: "1.0.0", neo4j: "5.26-community", caddy: "2-alpine" },
  minInstaller: "1.0.0",
  notes: "https://example.com",
};

test("parses a well-formed manifest", () => {
  const s = parseStack(GOOD);
  assert.equal(s.stack, "1.0.0");
  assert.equal(s.components.neo4j, "5.26-community");
});

for (const key of ["backend", "frontend", "chat", "neo4j", "caddy"]) {
  test(`throws when components.${key} is missing`, () => {
    const bad = structuredClone(GOOD) as Record<string, any>;
    delete bad.components[key];
    assert.throws(() => parseStack(bad), new RegExp(key));
  });
}

test("throws when stack version is missing", () => {
  const bad = structuredClone(GOOD) as Record<string, any>;
  delete bad.stack;
  assert.throws(() => parseStack(bad), /stack/);
});

test("throws when minInstaller is missing", () => {
  const bad = structuredClone(GOOD) as Record<string, any>;
  delete bad.minInstaller;
  assert.throws(() => parseStack(bad), /minInstaller/);
});

test("throws on a non-object manifest", () => {
  assert.throws(() => parseStack("nope"), /manifest/i);
});

test("accepts an installer newer than minInstaller", () => {
  assertInstallerSupported(parseStack(GOOD), "1.2.0");
});

test("accepts an installer exactly equal to minInstaller", () => {
  assertInstallerSupported(parseStack(GOOD), "1.0.0");
});

test("rejects an installer older than minInstaller, naming the upgrade command", () => {
  const s = parseStack({ ...GOOD, minInstaller: "2.0.0" });
  assert.throws(() => assertInstallerSupported(s, "1.0.0"), /@mocaos\/cortex@latest/);
});

test("builds fully-qualified GHCR image refs", () => {
  assert.deepEqual(imageRefs(parseStack(GOOD)), {
    backend: "ghcr.io/mocaos/cortex-backend:1.0.0",
    frontend: "ghcr.io/mocaos/cortex-frontend:1.0.0",
    chat: "ghcr.io/mocaos/cortex-chat:1.0.0",
  });
});

test("fetchStack uses the latest-release URL by default", async () => {
  let seen = "";
  const s = await fetchStack({
    fetchImpl: (async (url: any) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => GOOD } as any;
    }) as typeof fetch,
  });
  assert.equal(s.stack, "1.0.0");
  assert.match(seen, /releases\/latest\/download\/stack\.json$/);
});

test("fetchStack targets a specific tag when given a version", async () => {
  let seen = "";
  await fetchStack({
    version: "1.2.3",
    fetchImpl: (async (url: any) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => ({ ...GOOD, stack: "1.2.3" }) } as any;
    }) as typeof fetch,
  });
  assert.match(seen, /releases\/download\/v1\.2\.3\/stack\.json$/);
});

test("fetchStack surfaces a non-OK response with its status", async () => {
  await assert.rejects(
    fetchStack({ fetchImpl: (async () => ({ ok: false, status: 503 }) as any) as typeof fetch }),
    /503/
  );
});
