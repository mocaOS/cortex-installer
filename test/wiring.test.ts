import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Pins the invariant two expensive fix rounds already paid for: every command
 * that needs "is chat installed right now" must go through the single
 * reconciliation in src/chat.ts (effectiveChat / readEffectiveChat), never
 * chatEnabledFor(state) directly — chatEnabledFor only ever reads cortex.json,
 * which is exactly the stale half of the picture once .env can disagree with
 * it (see chat.ts's doc comment).
 *
 * Both regressions these tests target left all other tests green: reverting
 * commands/start.ts to chatEnabledFor(state) is the literal 1.2.1 bug, and
 * `down` silently dropping its DOWN_ENV overlay reintroduces the container
 * leak Task 7 fixed — neither changes what any *other* function returns, only
 * whether the right call site is used. That is precisely why a behavioural
 * test cannot catch it and a static, source-reading one is what's added here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const COMMANDS_DIR = join(SRC, "commands");

const read = (path: string): string => readFileSync(path, "utf8");
const IMPORTS = (name: string) => new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`);

test("no file under src/commands/ imports chatEnabledFor directly", () => {
  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    assert.ok(
      !IMPORTS("chatEnabledFor").test(read(join(COMMANDS_DIR, f))),
      `${f} imports chatEnabledFor directly — it must go through effectiveChat/readEffectiveChat (src/chat.ts) instead`
    );
  }
});

test("start.ts resolves chat through the shared helper (readEffectiveChat)", () => {
  const text = read(join(COMMANDS_DIR, "start.ts"));
  assert.match(text, IMPORTS("readEffectiveChat"), "must import readEffectiveChat from ../chat.js");
  assert.match(text, /readEffectiveChat\(/, "must actually call it, not just import it");
});

test("update.ts resolves chat through the shared helper (effectiveChat)", () => {
  const text = read(join(COMMANDS_DIR, "update.ts"));
  assert.match(text, IMPORTS("effectiveChat"), "must import effectiveChat from ../chat.js");
  assert.match(text, /effectiveChat\(/, "must actually call it, not just import it");
});

test("down() passes the DOWN_ENV profile overlay to run(), not process.env alone", () => {
  const text = read(join(SRC, "docker.ts"));
  const fn = text.match(/export async function down\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, "could not locate the down() function body in docker.ts");
  assert.match(fn![0], /DOWN_ENV/, "down() must reference DOWN_ENV so a chat container survives no matter what .env currently selects");
});
