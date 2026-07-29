import { execFile } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import { CHAT_OPTIONAL_SINCE } from "./stack.js";

const exec = promisify(execFile);

const REPO = "mocaOS/cortex-app";

/**
 * Files the codebase knows about across every supported release — NOT the
 * set required from any one release. Caddyfile.chat.template in particular
 * only exists from CHAT_OPTIONAL_SINCE onward (see requiredArtifactFiles,
 * which is what fetchArtifacts actually validates a given release against).
 * Kept listing both regardless of version so "both Caddyfile templates are
 * required artifacts" below still expresses the current, full contract.
 */
export const ARTIFACT_FILES = [
  "docker-compose.yml",
  "docker-compose.ports.yml",
  "docker-compose.caddy.yml",
  "Caddyfile.template",
  "Caddyfile.chat.template",
  ".env.example",
] as const;

/**
 * True once a release ships the split Caddyfile templates (cortex-app
 * "feat(selfhost): split the Caddyfile into app-only and with-chat
 * templates"). Before CHAT_OPTIONAL_SINCE, a release ships only
 * Caddyfile.template, and it already contains both site blocks — there was
 * no split yet, so that single file IS the with-chat template on those tags,
 * not a partial one.
 *
 * Mirrors supportsOptionalChat() in stack.ts (same gate, same
 * CHAT_OPTIONAL_SINCE) but takes the bare version string fetchArtifacts
 * already has, rather than requiring a full Stack object be built just to
 * ask this question.
 */
function shipsSeparateChatTemplate(version: string): boolean {
  return semver.valid(version) !== null && semver.gte(version, CHAT_OPTIONAL_SINCE);
}

/**
 * The artifacts THIS release's version must contain. Releases before
 * CHAT_OPTIONAL_SINCE never shipped Caddyfile.chat.template — requiring it
 * there would fail every pinned old-stack install (chat true OR false) on a
 * file that release never had to begin with, not a genuinely missing
 * artifact.
 */
export function requiredArtifactFiles(version: string): readonly string[] {
  if (shipsSeparateChatTemplate(version)) {
    return ARTIFACT_FILES;
  }
  return ARTIFACT_FILES.filter((f) => f !== "Caddyfile.chat.template");
}

/**
 * Which template to copy to ./Caddyfile, for this release version and chat
 * choice.
 *
 * Releases before CHAT_OPTIONAL_SINCE have only Caddyfile.template, which (see
 * shipsSeparateChatTemplate) already contains both site blocks. wizard.ts and
 * buildConfigNonInteractive force chat: true for exactly those releases
 * (their compose has no profile to switch chat off with), so "copy the
 * app-only template" is never the right instruction for one: the file does
 * not exist there, and copying it would also be semantically wrong even if it
 * did, since Compose is about to start the chat container regardless.
 */
export function caddyTemplateFor(version: string, chat: boolean): string {
  if (!shipsSeparateChatTemplate(version)) {
    return "Caddyfile.template";
  }
  return chat ? "Caddyfile.chat.template" : "Caddyfile.template";
}

/**
 * Downloads the release tarball for `version` and lays the self-host artifacts
 * into `dir`. `ops/` must land beside the compose files because the backup
 * service builds from ./ops/backup, relative to the compose file. The release
 * attaches only stack.json, so the tarball is the supply route.
 */
export async function fetchArtifacts(opts: {
  version: string;
  dir: string;
  chat: boolean;
}): Promise<void> {
  /**
   * codeload, NOT api.github.com/repos/.../tarball/.
   *
   * The API endpoint is rate-limited to 60 requests per hour per IP for
   * unauthenticated callers, and that quota is shared by everything else on the
   * address. Behind office NAT, a CI runner or a CGNAT'd home ISP the limit can
   * already be spent by someone else entirely, and the installer then dies on an
   * opaque `curl: (22) The requested URL returned error: 403` — after the
   * wizard, with no hint that waiting an hour is the fix.
   *
   * /archive/refs/tags/<tag>.tar.gz serves the identical tarball from the same
   * CDN the API redirects to anyway, and is not subject to the API rate limit.
   * The only difference is the archive's top-level directory name, which is
   * discovered from the listing below rather than assumed.
   */
  const url = `https://github.com/${REPO}/archive/refs/tags/v${opts.version}.tar.gz`;
  const work = mkdtempSync(join(tmpdir(), "cortex-art-"));
  const tgz = join(work, "src.tar.gz");

  try {
    // curl over fetch: follows redirects to codeload and streams to disk
    // without buffering a 6 MB body in memory.
    await exec("curl", ["-fsSL", url, "-o", tgz]);

    // Discover the archive's top-level directory instead of globbing for it.
    // GNU tar (every Linux install — the primary target) REFUSES wildcards in
    // member names without --wildcards, which bsdtar does not accept, so a
    // glob that works on macOS extracts nothing on Linux:
    //   tar: Pattern matching characters used in file names
    //   tar: mocaOS-cortex-app-*/selfhost: Not found in archive
    // Literal paths need no wildcard support and behave identically on both.
    //
    // maxBuffer: the real v1.0.0 listing is ~35 KB for 581 entries — comfortably
    // under Node's 1 MB default — but a silently-truncated listing would fail
    // obscurely ("stdout maxBuffer exceeded") on some future, much larger
    // release, so this is sized with generous headroom rather than left at
    // the default.
    const { stdout: listing } = await exec("tar", ["-tzf", tgz], { maxBuffer: 16 * 1024 * 1024 });
    const prefix = listing.split("\n")[0]?.split("/")[0];
    if (!prefix) {
      throw new Error(`release v${opts.version} tarball is empty or unreadable`);
    }

    await exec("tar", [
      "-xzf", tgz,
      "-C", work,
      "--strip-components=1",
      `${prefix}/selfhost`,
      `${prefix}/ops`,
    ]);

    const src = join(work, "selfhost");
    if (!existsSync(src)) {
      throw new Error(`release v${opts.version} contains no selfhost/ directory`);
    }
    cpSync(src, opts.dir, { recursive: true });
    cpSync(join(work, "ops"), join(opts.dir, "ops"), { recursive: true });

    // Validated BEFORE the Caddyfile copy below, on purpose: requiredArtifactFiles
    // is version-gated (a pre-CHAT_OPTIONAL_SINCE release never shipped
    // Caddyfile.chat.template), so this is the check that must decide whether a
    // release is genuinely incomplete. Running it first means a missing file
    // always surfaces as the message below — never as cpSync throwing ENOENT on
    // a template the copy step below picked but this release never had.
    for (const f of requiredArtifactFiles(opts.version)) {
      if (!existsSync(join(opts.dir, f))) {
        throw new Error(`release v${opts.version} is missing selfhost/${f}`);
      }
    }

    // The caddy overlay bind-mounts ./Caddyfile. If it is missing Docker
    // creates a root-owned DIRECTORY with that name and Caddy crash-loops on
    // "is a directory" with nothing pointing at the cause.
    //
    // Which template depends on the install: the app-only one omits the chat
    // site block, because a block whose {$CHAT_DOMAIN} is unset makes Caddy
    // refuse to adapt the entire config rather than merely warn. See
    // caddyTemplateFor for why that choice collapses to a single template on
    // releases before CHAT_OPTIONAL_SINCE.
    cpSync(
      join(opts.dir, caddyTemplateFor(opts.version, opts.chat)),
      join(opts.dir, "Caddyfile")
    );
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (/404/.test(msg)) {
      throw new Error(`No release found for v${opts.version} (HTTP 404)`);
    }
    // 403 from GitHub is almost never "forbidden" here — the repo is public and
    // the URL takes no credentials. It means either a rate limit or an egress
    // proxy refusing the request, both of which the operator can act on.
    if (/\b403\b/.test(msg)) {
      throw new Error(
        `GitHub refused the download for v${opts.version} (HTTP 403). This is usually ` +
          `a rate limit on your IP — wait a few minutes and retry — or an outbound ` +
          `proxy blocking github.com. Verify with:\n` +
          `  curl -fsSLI ${url}`
      );
    }
    throw new Error(`Could not fetch release artifacts for v${opts.version}: ${msg}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
