import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync, type FileLockSyncHandle } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

type ParentFixture = {
  outside: string;
  realParent: string;
  kept: string;
  missing: string;
  leaked: string;
  lockPath: string;
  target: string;
  lockRoot: Awaited<ReturnType<typeof root>>;
};

async function createParentFixture(prefix: string): Promise<ParentFixture> {
  const sandbox = await tempRoot(prefix);
  const base = path.join(sandbox, "base");
  const outside = path.join(sandbox, "outside");
  const realParent = path.join(base, "real");
  fs.mkdirSync(base);
  fs.mkdirSync(outside);
  fs.mkdirSync(realParent);
  return {
    outside,
    realParent,
    kept: path.join(base, "real-kept"),
    missing: path.join(realParent, "missing"),
    leaked: path.join(outside, "missing"),
    lockPath: path.join(realParent, "missing", "state.lock"),
    target: path.join(base, "state.json"),
    lockRoot: await root(base),
  };
}

function swapParentForOutsideSymlink(fixture: ParentFixture): void {
  fs.renameSync(fixture.realParent, fixture.kept);
  fs.symlinkSync(
    fixture.outside,
    fixture.realParent,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function acquire(fixture: ParentFixture): FileLockSyncHandle {
  return acquireFileLockSync(fixture.target, {
    ...immediate,
    lockPath: fixture.lockPath,
    lockRoot: fixture.lockRoot,
    payload: () => ({ owner: "rollback" }),
  });
}

function attemptAcquire(fixture: ParentFixture): unknown {
  let held: FileLockSyncHandle | undefined;
  try {
    held = acquire(fixture);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    held?.release();
  }
}

describe("lock parent mkdir rollback", () => {
  it("removes a parent directory created through a swapped symlink when the post-create check fails", async () => {
    const fixture = await createParentFixture("fs-safe-lock-parent-mkdir-rollback-");
    const realMkdir = fs.mkdirSync.bind(fs);
    const mkdirPaths: string[] = [];
    let swapped = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      const pathname = path.resolve(String(args[0]));
      mkdirPaths.push(pathname);
      // Admission already accepted the real parent. Swap in the mkdir window.
      if (pathname === path.resolve(fixture.missing) && !swapped) {
        swapped = true;
        swapParentForOutsideSymlink(fixture);
      }
      return realMkdir(...args);
    }) as typeof fs.mkdirSync);

    const caught = attemptAcquire(fixture);

    expect(swapped, `mkdir paths: ${mkdirPaths.join(", ")}`).toBe(true);
    expect(caught).toMatchObject({
      code: "path-mismatch",
      message: "sidecar lock parent changed during operation",
    });
    expect(fs.existsSync(fixture.leaked)).toBe(false);
    expect(fs.existsSync(path.join(fixture.kept, "missing"))).toBe(false);
    expect(fs.existsSync(fixture.lockPath)).toBe(false);
    expect(fs.lstatSync(fixture.realParent).isSymbolicLink()).toBe(true);
    expect(fs.statSync(fixture.kept).isDirectory()).toBe(true);
    expect(fs.statSync(fixture.outside).isDirectory()).toBe(true);
  });

  it("does not remove a raced parent when mkdir reports EEXIST", async () => {
    const fixture = await createParentFixture("fs-safe-lock-parent-mkdir-eexist-");
    const realMkdir = fs.mkdirSync.bind(fs);
    const rmdir = vi.spyOn(fs, "rmdirSync");
    let swapped = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      const pathname = path.resolve(String(args[0]));
      if (pathname !== path.resolve(fixture.missing) || swapped) return realMkdir(...args);
      swapped = true;
      swapParentForOutsideSymlink(fixture);
      realMkdir(...args);
      throw Object.assign(new Error("parent already exists"), { code: "EEXIST" });
    }) as typeof fs.mkdirSync);

    const caught = attemptAcquire(fixture);

    expect(swapped).toBe(true);
    expect(caught).toMatchObject({
      code: "path-mismatch",
      message: "sidecar lock parent changed during operation",
    });
    expect(rmdir).not.toHaveBeenCalled();
    expect(fs.statSync(fixture.leaked).isDirectory()).toBe(true);
    expect(fs.existsSync(fixture.lockPath)).toBe(false);
  });

  it("preserves the post-create check error when removing the created parent fails", async () => {
    const fixture = await createParentFixture("fs-safe-lock-parent-mkdir-rmdir-");
    const realMkdir = fs.mkdirSync.bind(fs);
    const realRmdir = fs.rmdirSync.bind(fs);
    const cleanupError = Object.assign(new Error("parent removal failed"), { code: "EACCES" });
    let swapped = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      const pathname = path.resolve(String(args[0]));
      if (pathname === path.resolve(fixture.missing) && !swapped) {
        swapped = true;
        swapParentForOutsideSymlink(fixture);
      }
      return realMkdir(...args);
    }) as typeof fs.mkdirSync);
    const rmdir = vi.spyOn(fs, "rmdirSync").mockImplementation((candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(fixture.missing)) throw cleanupError;
      realRmdir(candidate);
    });

    const caught = attemptAcquire(fixture);

    expect(swapped).toBe(true);
    expect(rmdir).toHaveBeenCalled();
    expect(caught).toMatchObject({
      name: "SuppressedError",
      error: expect.objectContaining({
        code: "path-mismatch",
        message: "sidecar lock parent changed during operation",
      }),
      suppressed: cleanupError,
    });
    expect((caught as { error?: unknown; suppressed?: unknown }).error).toMatchObject({
      code: "path-mismatch",
    });
    expect((caught as { suppressed?: unknown }).suppressed).toBe(cleanupError);
    expect(fs.statSync(fixture.leaked).isDirectory()).toBe(true);
  });

  it("keeps a parent directory this call created when admission succeeds", async () => {
    const fixture = await createParentFixture("fs-safe-lock-parent-mkdir-keep-");
    const held = acquire(fixture);
    try {
      expect(fs.statSync(fixture.missing).isDirectory()).toBe(true);
      expect(fs.statSync(fixture.lockPath).isFile()).toBe(true);
    } finally {
      held.release();
    }
    expect(fs.statSync(fixture.missing).isDirectory()).toBe(true);
    expect(fs.existsSync(fixture.lockPath)).toBe(false);
    expect(fs.existsSync(fixture.leaked)).toBe(false);
  });
});
