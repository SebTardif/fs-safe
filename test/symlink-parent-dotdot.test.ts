import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendRegularFile } from "../src/regular-file.js";
import { assertNoSymlinkParentsSync } from "../src/symlink-parents.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

// path.join normalizes `..` away. Keep the raw segment so the guard sees it.
function rawPath(rootDir: string, ...segments: string[]): string {
  return [rootDir, ...segments].join(path.sep);
}

async function symlinkDir(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("symlink parents cancelled by dotdot", () => {
  it("rejects a symlink ancestor that dotdot would lexically cancel", async () => {
    const base = await tempRoot("fs-safe-symlink-dotdot-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    await fs.mkdir(path.join(rootDir, "sub"), { recursive: true });
    await fs.mkdir(outside);
    await symlinkDir(outside, path.join(rootDir, "sub", "up"));

    expect(() => assertNoSymlinkParentsSync({
      rootDir,
      targetPath: rawPath(rootDir, "sub", "up", "..", "secret"),
    })).toThrow(/must not traverse symlinked directory/);
  });

  it("allows dotdot through a real directory", async () => {
    const rootDir = await tempRoot("fs-safe-symlink-dotdot-real-");
    await fs.mkdir(path.join(rootDir, "sub"));

    expect(() => assertNoSymlinkParentsSync({
      rootDir,
      targetPath: rawPath(rootDir, "sub", "..", "file"),
    })).not.toThrow();
  });

  it("refuses appendRegularFile when dotdot cancels a symlink parent", async () => {
    const base = await tempRoot("fs-safe-symlink-dotdot-append-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    const outsideFile = path.join(base, "secret");
    await fs.mkdir(path.join(rootDir, "sub"), { recursive: true });
    await fs.mkdir(outside);
    await symlinkDir(outside, path.join(rootDir, "sub", "up"));

    await expect(appendRegularFile({
      filePath: rawPath(rootDir, "sub", "up", "..", "secret"),
      content: "x",
      rejectSymlinkParents: true,
    })).rejects.toThrow(/symlinked directory/);
    expect(fsSync.existsSync(outsideFile)).toBe(false);
  });
});
