import pc from "picocolors";
import * as p from "@clack/prompts";

/** Colour is suppressed by NO_COLOR, --no-color, or a non-TTY stdout. */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.argv.includes("--no-color")) return false;
  return process.stdout.isTTY === true;
}

const dim = (s: string) => (colorEnabled() ? pc.dim(s) : s);
const bold = (s: string) => (colorEnabled() ? pc.bold(s) : s);

export function banner(version: string): void {
  p.intro(`${bold("Cortex")} ${dim(`self-host installer ${version}`)}`);
}

/** A boxed group of key/value or plain lines. */
export function noteBox(title: string, lines: string[]): void {
  p.note(lines.join("\n"), title);
}

export { p as prompts };
