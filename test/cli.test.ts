import { test } from "node:test";
import assert from "node:assert/strict";
// ../src/args.js, not ../src/cli.js: cli.ts is the bin entry point and runs
// main() unconditionally, so importing it here would execute the CLI. Keeping
// the parser in its own module is what lets cli.ts drop the argv[1] guard that
// silently broke every symlinked `node_modules/.bin/cortex` invocation.
import { parseArgs } from "../src/args.js";

test("defaults to the install verb", () => {
  const r = parseArgs([]);
  assert.equal(r.verb, "install");
});

test("takes the first non-flag token as the verb", () => {
  assert.equal(parseArgs(["update"]).verb, "update");
  assert.equal(parseArgs(["logs", "backend"]).verb, "logs");
});

test("collects positionals after the verb", () => {
  assert.deepEqual(parseArgs(["logs", "backend"]).positionals, ["backend"]);
});

test("parses long flags with values", () => {
  const r = parseArgs(["install", "--dir", "/opt/cortex"]);
  assert.equal(r.flags.dir, "/opt/cortex");
});

test("parses --key=value form", () => {
  assert.equal(parseArgs(["install", "--dir=/opt/cortex"]).flags.dir, "/opt/cortex");
});

test("treats a valueless flag as boolean true", () => {
  assert.equal(parseArgs(["install", "--yes"]).flags.yes, true);
});

test("a flag before the verb still parses and the verb is still found", () => {
  const r = parseArgs(["--yes", "update"]);
  assert.equal(r.verb, "update");
  assert.equal(r.flags.yes, true);
});

test("rejects an unknown verb instead of silently installing", () => {
  assert.throws(() => parseArgs(["staus"]), /Unknown command "staus"/);
});

test("still defaults to install when no verb is given at all", () => {
  assert.equal(parseArgs(["--yes"]).verb, "install");
});
