#!/usr/bin/env node
// The tag must match package.json, so a release can never publish a version
// that disagrees with what `cortex --version` reports.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
const tagArg = process.argv[process.argv.indexOf("--tag") + 1];
const tag = tagArg?.startsWith("v") ? tagArg.slice(1) : tagArg;

if (tag && tag !== pkg) {
  console.error(`tag ${tagArg} does not match package.json version ${pkg}`);
  process.exit(1);
}
console.log(`Version ${pkg} OK`);
