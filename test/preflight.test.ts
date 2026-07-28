import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  parseDockerVersion,
  parseComposeVersion,
  checkArch,
  checkPort,
  probePort,
  runPreflight,
  filterProjectVolumes,
  parseDfAvailGb,
} from "../src/preflight.js";

test("parses `docker version --format` output", () => {
  assert.equal(parseDockerVersion("27.3.1\n"), "27.3.1");
});

test("parses a docker version with build metadata", () => {
  assert.equal(parseDockerVersion("27.3.1-rd\n"), "27.3.1");
});

test("returns null for unparseable docker output", () => {
  assert.equal(parseDockerVersion("Cannot connect to the Docker daemon"), null);
});

test("parses the Available column of `df -Pk`", () => {
  const out = [
    "Filesystem   1024-blocks      Used Available Capacity  Mounted on",
    "/dev/disk3s1   482797652 421670756  22007180    96%    /System/Volumes/Data",
  ].join("\n");
  // 22007180 KB / 1024^2 ≈ 20.98 GB
  const gb = parseDfAvailGb(out);
  assert.ok(gb !== null && Math.abs(gb - 20.98) < 0.05, `got ${gb}`);
});

test("parses GNU df output, whose device column wraps differently", () => {
  const out = [
    "Filesystem     1024-blocks     Used Available Capacity Mounted on",
    "/dev/nvme0n1p2   982940904 41288120 891661320       5% /",
  ].join("\n");
  const gb = parseDfAvailGb(out);
  assert.ok(gb !== null && gb > 800 && gb < 900, `got ${gb}`);
});

test("returns null for df's error output rather than a bogus number", () => {
  // Docker Desktop reports DockerRootDir=/var/lib/docker, a path that exists
  // only inside the VM. df on the host errors — this must degrade to null so
  // the caller falls through to the next candidate path.
  assert.equal(parseDfAvailGb("df: /var/lib/docker: No such file or directory"), null);
  assert.equal(parseDfAvailGb(""), null);
});

test("the disk check resolves even when Docker's root dir is not a host path", async () => {
  // Regression: the check used to measure ONLY docker info's DockerRootDir, so
  // every Docker Desktop install (macOS/Windows — a VM-backed daemon) reported
  // "could not determine free disk space" as a FAIL on an otherwise healthy
  // machine. The candidate chain now falls back to host paths.
  const r = await runPreflight({ dir: "/nonexistent-install-dir-for-test" });
  const disk = r.checks.find((c) => c.name === "Disk");
  assert.ok(disk, "expected a Disk check");
  assert.ok(
    !/could not determine/.test(disk.detail),
    `disk check degraded to unknown: ${disk.detail}`
  );
  assert.match(disk.detail, /\d+ GB free/);
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

// filterProjectVolumes is the pure part of existingProjectVolumes, factored
// out so this can be tested without depending on this machine's real Docker
// volumes (which will differ, and may legitimately be empty, on any given
// test runner).
test("filterProjectVolumes matches a volume that belongs to the project", () => {
  const names = ["cortex_neo4j_data", "cortex_uploads_data"];
  assert.deepEqual(filterProjectVolumes(names, "cortex"), names);
});

test("filterProjectVolumes rejects a name that merely shares a prefix", () => {
  // "cortexfoo_data" is NOT project "cortex" — the underscore boundary matters.
  assert.deepEqual(filterProjectVolumes(["cortexfoo_data"], "cortex"), []);
});

test("filterProjectVolumes ignores unrelated projects", () => {
  assert.deepEqual(
    filterProjectVolumes(["meta-cortex_database-data", "other_data"], "cortex"),
    []
  );
});

test("filterProjectVolumes trims whitespace from `docker volume ls` output lines", () => {
  assert.deepEqual(filterProjectVolumes(["  cortex_neo4j_data  ", ""], "cortex"), [
    "cortex_neo4j_data",
  ]);
});

test("filterProjectVolumes returns nothing for a project with no existing volumes", () => {
  assert.deepEqual(filterProjectVolumes(["unrelated_data"], "cortex-e2e"), []);
});

// --- probePort: "in use" vs "not allowed to find out" -----------------------
// Binding a port below 1024 needs root on Linux and macOS alike, so probing
// 80/443 as the ordinary user who runs the installer fails with EACCES. Treating
// that as a conflict would abort every non-root domain-mode install on a host
// where :80 is in fact free, so the errno has to be carried out of the probe.
test("probePort reports a free port as free with no errno", async () => {
  const r = await probePort(45241);
  assert.equal(r.free, true);
  assert.equal(r.code, undefined);
});

test("probePort distinguishes a genuinely occupied port with EADDRINUSE", async () => {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(45242, "127.0.0.1", res));
  try {
    const r = await probePort(45242);
    assert.equal(r.free, false);
    assert.equal(r.code, "EADDRINUSE");
  } finally {
    await new Promise<void>((res) => srv.close(() => res()));
  }
});

test("runPreflight marks a genuinely occupied port fatal only when portsFatal is set", async () => {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(45243, "127.0.0.1", res));
  try {
    const warn = await runPreflight({ ports: [45243] });
    const wc = warn.checks.find((c) => c.port === 45243)!;
    assert.equal(wc.ok, false);
    assert.equal(wc.fatal, false, "the wizard path must only warn — it resolves conflicts itself");
    assert.match(wc.detail, /in use/);

    const fatal = await runPreflight({ ports: [45243], portsFatal: true });
    const fc = fatal.checks.find((c) => c.port === 45243)!;
    assert.equal(fc.fatal, true, "--yes cannot prompt, so an occupied port must abort");
    assert.equal(fatal.ok, false);
  } finally {
    await new Promise<void>((res) => srv.close(() => res()));
  }
});

test("an unverifiable privileged port never aborts the install, even under portsFatal", async () => {
  // Skipped when running as root, where 80 is genuinely bindable and this
  // distinction cannot arise.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const r = await runPreflight({ ports: [80], portsFatal: true });
  const c = r.checks.find((x) => x.port === 80)!;
  // Either the port bound (some sandboxes permit it) or it could not be checked.
  if (!c.ok) {
    assert.equal(c.fatal, false, "EACCES means 'cannot check', not 'occupied'");
    assert.match(c.detail, /cannot verify/);
    assert.equal(r.ok, true, "an unperformable check must not fail the report");
  }
});

test("port checks are tagged with their port so callers need no string matching", async () => {
  const r = await runPreflight({ ports: [45244] });
  assert.equal(r.checks.filter((c) => c.port !== undefined).length, 1);
  assert.equal(r.checks.find((c) => c.port === 45244)!.name, "Port 45244");
});

// curl and tar are hard requirements of fetchArtifacts, which shells out to
// both. Debian's minimal images ship wget but not curl.
test("runPreflight checks for curl and tar, fatally", async () => {
  const r = await runPreflight({});
  for (const bin of ["curl", "tar"]) {
    const c = r.checks.find((x) => x.name === bin);
    assert.ok(c, `no preflight check for ${bin}`);
    assert.equal(c!.fatal, true, `${bin} must be fatal — fetchArtifacts cannot work without it`);
  }
});
