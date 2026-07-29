import { test } from "node:test";
import assert from "node:assert/strict";
import { composeArgs, parsePullProgress, parseHealth, healthServices, ServiceStatus, UP_ARGS } from "../src/docker.js";

test("up passes --build, without which an update never reaches the locally built backup sidecar", () => {
  // The sidecar is built from the release's ops/backup directory. Compose builds
  // a missing image but never rebuilds an existing one because its context
  // changed, so a corrected backup/restore script would land on disk and keep
  // running the image built at install time. Verified against real Compose: after
  // replacing ops/backup/restore.sh, `up -d --remove-orphans` left the image
  // stale; adding --build rebuilt it.
  assert.ok(UP_ARGS.includes("--build"), `--build missing from up args: ${UP_ARGS.join(" ")}`);
  assert.deepEqual(UP_ARGS, ["up", "-d", "--remove-orphans", "--build"]);
});

test("composeArgs pins the project directory (cwd independence additionally requires cwd: dir on the child process — see run/pull/logs)", () => {
  const a = composeArgs("/opt/cortex");
  assert.deepEqual(a.slice(0, 3), ["compose", "--project-directory", "/opt/cortex"]);
});

test("parsePullProgress recognises a completed pull line (bare two-token form, older Compose)", () => {
  const r = parsePullProgress(" backend Pulled ");
  assert.deepEqual(r, { image: "backend", done: true });
});

test("parsePullProgress recognises an in-flight pull line (bare two-token form, older Compose)", () => {
  const r = parsePullProgress(" neo4j Pulling ");
  assert.deepEqual(r, { image: "neo4j", done: false });
});

// Real docker compose v5.1.3 output is three tokens: "Image <ref> <state>".
test("parsePullProgress recognises the real three-token completed-pull line", () => {
  const r = parsePullProgress(" Image ghcr.io/mocaos/cortex-chat:1.0.0 Pulled");
  assert.deepEqual(r, { image: "ghcr.io/mocaos/cortex-chat:1.0.0", done: true });
});

test("parsePullProgress recognises the real three-token in-flight line", () => {
  const r = parsePullProgress(" Image ghcr.io/mocaos/cortex-chat:1.0.0 Pulling");
  assert.deepEqual(r, { image: "ghcr.io/mocaos/cortex-chat:1.0.0", done: false });
});

test("parsePullProgress recognises a second real completed-pull line (neo4j)", () => {
  const r = parsePullProgress(" Image neo4j:5.26-community Pulled");
  assert.deepEqual(r, { image: "neo4j:5.26-community", done: true });
});

test("parsePullProgress ignores a Skipped line (buildable services like backup emit this, not Pulled/Pulling)", () => {
  assert.equal(parsePullProgress(" backup Skipped No image to be pulled"), null);
});

test("parsePullProgress ignores layer chatter", () => {
  assert.equal(parsePullProgress(" 1f2a3b4c Downloading [====>   ] 12.4MB/98MB"), null);
});

test("parsePullProgress ignores blank lines", () => {
  assert.equal(parsePullProgress("   "), null);
});

test("parseHealth reads compose ps --format json lines", () => {
  const json = [
    JSON.stringify({ Service: "neo4j", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "backend", State: "running", Health: "starting" }),
    JSON.stringify({ Service: "frontend", State: "running", Health: "" }),
  ].join("\n");
  assert.deepEqual(parseHealth(json), [
    { service: "neo4j", state: "running", health: "healthy" },
    { service: "backend", state: "running", health: "starting" },
    { service: "frontend", state: "running", health: null },
  ]);
});

test("parseHealth handles a single JSON array instead of lines", () => {
  const json = JSON.stringify([{ Service: "chat", State: "running", Health: "" }]);
  assert.deepEqual(parseHealth(json), [{ service: "chat", state: "running", health: null }]);
});

test("parseHealth returns an empty list for empty input", () => {
  assert.deepEqual(parseHealth(""), []);
});

test("parseHealth falls through to per-line parsing when array parse fails", () => {
  // Simulates broken array syntax followed by valid NDJSON and stderr chatter.
  const malformed = `[{corrupted\n${JSON.stringify({ Service: "neo4j", State: "running", Health: "healthy" })}\nno configuration file provided: not found`;
  assert.deepEqual(parseHealth(malformed), [
    { service: "neo4j", state: "running", health: "healthy" },
  ]);
});

test("parseHealth degrades gracefully when NDJSON is followed by stderr", () => {
  // Simulates docker compose ps output: NDJSON followed by stderr warning.
  const ndjsonWithStderr = `${JSON.stringify({ Service: "chat", State: "running", Health: "" })}\nvariable is not set`;
  assert.deepEqual(parseHealth(ndjsonWithStderr), [
    { service: "chat", state: "running", health: null },
  ]);
});

test("parseHealth spreads arrays found in per-line parsing, not phantom rows", () => {
  // When array + stderr is handed to the per-line parser, the first line is the full array.
  // It must be spread into rows, not pushed as a single phantom row with no Service field.
  const arrayWithStderr = `${JSON.stringify([
    { Service: "neo4j", State: "running", Health: "healthy" },
    { Service: "chat", State: "running", Health: "" },
  ])}\nunexpected stderr warning`;
  const result = parseHealth(arrayWithStderr);
  assert.equal(result.length, 2, "must extract 2 services, not 1 phantom row");
  assert.deepEqual(result, [
    { service: "neo4j", state: "running", health: "healthy" },
    { service: "chat", state: "running", health: null },
  ]);
});

// --- healthServices --------------------------------------------------------
// caddy is the only service publishing ports in domain mode, so leaving it out
// of the health wait let the installer print "All services healthy" plus https
// URLs while nothing was listening on 80/443. It must equally NOT be watched in
// localhost mode, where the caddy overlay is not composed in at all and waiting
// on it would burn the full timeout on a container that never exists.
test("healthServices watches caddy in domain mode", () => {
  const svc = healthServices("domain");
  assert.ok(svc.includes("caddy"), `expected caddy in ${JSON.stringify(svc)}`);
  assert.deepEqual(svc, ["neo4j", "backend", "frontend", "chat", "caddy"]);
});

test("healthServices does not watch caddy in localhost mode", () => {
  const svc = healthServices("localhost");
  assert.ok(!svc.includes("caddy"), `caddy must not be watched: ${JSON.stringify(svc)}`);
  assert.deepEqual(svc, ["neo4j", "backend", "frontend", "chat"]);
});

test("healthServices always watches the four application services", () => {
  for (const mode of ["localhost", "domain"] as const) {
    for (const name of ["neo4j", "backend", "frontend", "chat"]) {
      assert.ok(healthServices(mode).includes(name), `${mode} must watch ${name}`);
    }
  }
});

test("healthServices returns a fresh array each call (callers must not mutate shared state)", () => {
  const a = healthServices("domain");
  a.push("mutated");
  assert.ok(!healthServices("domain").includes("mutated"));
});
