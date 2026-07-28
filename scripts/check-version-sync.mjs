#!/usr/bin/env node
// The tag must match package.json, so a release can never publish a version
// that disagrees with what `cortex --version` reports.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;

// Fail loudly rather than open. This script is the only gate before an
// irreversible `npm publish`, so a missing or blank --tag must not sail
// through: `if (tag && ...)` would silently pass on an empty value, and an
// absent --tag makes indexOf return -1, which reads argv[0] (the node binary).
const i = process.argv.indexOf("--tag");
if (i === -1) {
  console.error("check-version-sync: --tag is required");
  process.exit(1);
}
const tagArg = process.argv[i + 1];
if (!tagArg) {
  console.error("check-version-sync: --tag was given no value");
  process.exit(1);
}
const tag = tagArg.startsWith("v") ? tagArg.slice(1) : tagArg;

if (tag !== pkg) {
  console.error(`tag ${tagArg} does not match package.json version ${pkg}`);
  process.exit(1);
}
console.log(`Version ${pkg} OK`);
