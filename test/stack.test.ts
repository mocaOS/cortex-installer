import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStack,
  assertInstallerSupported,
  imageRefs,
  fetchStack,
  supportsOptionalChat,
  CHAT_OPTIONAL_SINCE,
} from "../src/stack.js";

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

test("rejects an empty string for stack version", () => {
  const bad = structuredClone(GOOD) as Record<string, any>;
  bad.stack = "";
  assert.throws(() => parseStack(bad), /stack/);
});

test("rejects an empty string for minInstaller version", () => {
  const bad = structuredClone(GOOD) as Record<string, any>;
  bad.minInstaller = "";
  assert.throws(() => parseStack(bad), /minInstaller/);
});

for (const key of ["backend", "frontend", "chat", "neo4j", "caddy"]) {
  test(`rejects an empty string for components.${key}`, () => {
    const bad = structuredClone(GOOD) as Record<string, any>;
    bad.components[key] = "";
    assert.throws(() => parseStack(bad), new RegExp(key));
  });
}

test("rejects a non-semver stack version", () => {
  const bad = structuredClone(GOOD) as Record<string, any>;
  bad.stack = "invalid-version";
  assert.throws(() => parseStack(bad), /invalid.*stack.*version/i);
});

test("rejects a non-semver minInstaller version with a descriptive error", () => {
  const bad = structuredClone(GOOD) as Record<string, any>;
  bad.minInstaller = "latest";
  assert.throws(
    () => parseStack(bad),
    (err: any) => {
      // Verify it's not a raw TypeError from semver
      if (err instanceof TypeError) return false;
      // Verify the error message is descriptive, not a raw library error
      return /minInstaller/.test(err.message) && /latest/.test(err.message);
    }
  );
});

test("optional chat is gated on the stack release that introduced the profile", () => {
  // A new installer can still install an OLD stack (minInstaller only guards the
  // other direction). On a stack whose compose has no chat profile, omitting
  // COMPOSE_PROFILES would NOT disable chat — it would run anyway while the
  // installer reported it as off. So the question must not be asked there.
  const at = (v: string) => parseStack({ ...GOOD, stack: v });
  assert.equal(supportsOptionalChat(at("1.0.1")), false);
  assert.equal(supportsOptionalChat(at(CHAT_OPTIONAL_SINCE)), true);
  assert.equal(supportsOptionalChat(at("2.0.0")), true);
});
