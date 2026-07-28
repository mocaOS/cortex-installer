import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { parseDockerVersion, parseComposeVersion, checkArch, checkPort } from "../src/preflight.js";

test("parses `docker version --format` output", () => {
  assert.equal(parseDockerVersion("27.3.1\n"), "27.3.1");
});

test("parses a docker version with build metadata", () => {
  assert.equal(parseDockerVersion("27.3.1-rd\n"), "27.3.1");
});

test("returns null for unparseable docker output", () => {
  assert.equal(parseDockerVersion("Cannot connect to the Docker daemon"), null);
});

test("parses `docker compose version` output", () => {
  assert.equal(parseComposeVersion("Docker Compose version v2.29.7\n"), "2.29.7");
});

test("parses compose version without the v prefix", () => {
  assert.equal(parseComposeVersion("Docker Compose version 2.30.0\n"), "2.30.0");
});

test("returns null when the compose plugin is absent", () => {
  assert.equal(parseComposeVersion("docker: 'compose' is not a docker command."), null);
});

test("accepts amd64 and arm64", () => {
  assert.equal(checkArch("x64").ok, true);
  assert.equal(checkArch("arm64").ok, true);
});

test("rejects other architectures and names the arch", () => {
  const r = checkArch("ppc64");
  assert.equal(r.ok, false);
  assert.match(r.message!, /ppc64/);
});

test("checkPort reports a free port as free", async () => {
  assert.equal(await checkPort(45231), true);
});

test("checkPort reports a bound port as taken", async () => {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(45232, "127.0.0.1", res));
  try {
    assert.equal(await checkPort(45232), false);
  } finally {
    await new Promise<void>((res) => srv.close(() => res()));
  }
});
