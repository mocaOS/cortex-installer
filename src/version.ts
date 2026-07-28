import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Reads the published package version. dist/version.js -> ../package.json */
export function installerVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
}
