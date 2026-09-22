import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode, isPathRelativeEscape } from "./path.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type AssertNoSymlinkParentsOptions = {
  rootDir: string;
  targetPath: string;
  allowMissing?: boolean;
  allowOutsideRoot?: boolean;
  allowRootChildSymlink?: boolean;
  requireDirectories?: boolean;
  messagePrefix?: string;
};

function outsideRootError(params: AssertNoSymlinkParentsOptions, root: string): Error {
  return new Error(`${params.messagePrefix ?? "Path"} must stay under ${root}.`);
}

function absolutePreservingDotDot(targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return process.platform === "win32" ? targetPath.replaceAll("/", "\\") : targetPath;
  }
  if (process.platform === "win32" && /^[A-Za-z]:/.test(targetPath)) {
    const base = path.win32.resolve(targetPath.slice(0, 2));
    const suffix = targetPath.slice(2).replaceAll("/", "\\").replace(/^\\+/, "");
    if (suffix.length === 0) return base;
    return base.endsWith("\\") ? `${base}${suffix}` : `${base}\\${suffix}`;
  }
  const cwd = process.cwd();
  if (targetPath.length === 0) return cwd;
  const suffix = process.platform === "win32" ? targetPath.replaceAll("/", "\\") : targetPath;
  return cwd.endsWith(path.sep) ? `${cwd}${suffix}` : `${cwd}${path.sep}${suffix}`;
}

function trimTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  let end = value.length;
  while (end > root.length && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function hasPathPrefix(value: string, prefix: string): boolean {
  return process.platform === "win32"
    ? value.toLowerCase().startsWith(prefix.toLowerCase())
    : value.startsWith(prefix);
}

function rawTargetSegments(root: string, targetPath: string, lexicalRelative: string): string[] {
  const normalizedRoot = trimTrailingSeparators(root);
  const absoluteTarget = trimTrailingSeparators(absolutePreservingDotDot(targetPath));
  if (samePath(absoluteTarget, normalizedRoot)) return [];
  const rootBoundary = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  let suffix: string | undefined;
  if (hasPathPrefix(absoluteTarget, rootBoundary)) {
    suffix = absoluteTarget.slice(rootBoundary.length);
  } else if (
    normalizedRoot === path.parse(normalizedRoot).root &&
    hasPathPrefix(absoluteTarget, normalizedRoot)
  ) {
    suffix = absoluteTarget.slice(normalizedRoot.length);
  }
  if (suffix === undefined) {
    if (!lexicalRelative || lexicalRelative === ".") return [];
    return lexicalRelative.split(path.sep).filter((segment) => segment.length > 0);
  }
  const parts = process.platform === "win32" ? suffix.split(/[/\\]+/) : suffix.split(/\/+/);
  return parts.filter((segment) => segment.length > 0 && segment !== ".");
}

function resolvePathWalk(params: AssertNoSymlinkParentsOptions): {
  root: string;
  segments: string[];
} | null {
  const rawRootDir = params.rootDir;
  assertNoWindowsPathAlias(
    rawRootDir,
    "filesystem",
    "root dir uses a Windows filesystem namespace alias",
  );
  const rawTargetPath = params.targetPath;
  assertNoWindowsPathAlias(
    rawTargetPath,
    "filesystem",
    "target path uses a Windows filesystem namespace alias",
  );
  const root = resolvePathPreservingWindowsRoot(rawRootDir);
  const lexicalTarget = resolvePathPreservingWindowsRoot(rawTargetPath);
  const relative = path.relative(root, lexicalTarget);
  if (isPathRelativeEscape(relative)) {
    if (params.allowOutsideRoot) {
      return null;
    }
    throw outsideRootError(params, root);
  }
  return {
    root,
    segments: rawTargetSegments(root, rawTargetPath, relative),
  };
}

function formatUnsafePath(params: AssertNoSymlinkParentsOptions, current: string): string {
  return `${params.messagePrefix ?? "Path"} must not traverse symlinked directory: ${current}`;
}

export async function assertNoSymlinkParents(
  params: AssertNoSymlinkParentsOptions,
): Promise<void> {
  assertNoSymlinkParentsSync(params);
}

type WalkedSegment = { path: string; kind: "dir" | "symlink" };

function isFilesystemRoot(root: string): boolean {
  return root === path.parse(root).root;
}

export function assertNoSymlinkParentsSync(
  params: AssertNoSymlinkParentsOptions,
): void {
  const walk = resolvePathWalk(params);
  if (!walk) {
    return;
  }
  let current = walk.root;
  // `..` may only undo a real directory this walk already lstat'd.
  const walked: WalkedSegment[] = [];
  for (const [index, segment] of walk.segments.entries()) {
    if (segment === "..") {
      const top = walked[walked.length - 1];
      if (top?.kind === "dir") {
        walked.pop();
        current = walked[walked.length - 1]?.path ?? walk.root;
        continue;
      }
      if (top?.kind === "symlink") {
        throw new Error(formatUnsafePath(params, top.path));
      }
      if (!isFilesystemRoot(walk.root)) {
        throw outsideRootError(params, walk.root);
      }
      continue;
    }
    current = path.join(current, segment);
    try {
      const stat = fsSync.lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (params.allowRootChildSymlink && path.dirname(current) === walk.root) {
          walked.push({ path: current, kind: "symlink" });
          continue;
        }
        throw new Error(formatUnsafePath(params, current));
      }
      if ((params.requireDirectories || index < walk.segments.length - 1) && !stat.isDirectory()) {
        throw new FsSafeError(
          "not-file",
          `${params.messagePrefix ?? "Path"} must traverse directories: ${current}`,
        );
      }
      if (stat.isDirectory()) {
        walked.push({ path: current, kind: "dir" });
      }
    } catch (err) {
      if (hasNodeErrorCode(err, "ENOENT") && params.allowMissing !== false) {
        return;
      }
      throw err;
    }
  }
}
