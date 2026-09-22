import type { Stats } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function simulateWindows(): void {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
}

function patchedStat(stat: Stats, dev: number): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev });
}

function exitCleanup(): () => void {
  const cleanup = Reflect.get(
    globalThis,
    Symbol.for("fsSafe.sidecarLockCleanupHandler"),
  ) as (() => void) | undefined;
  expect(cleanup).toBeTypeOf("function");
  return cleanup as () => void;
}

function deletedLock(rmSync: { mock: { calls: unknown[][] } }, lockPath: string): boolean {
  return rmSync.mock.calls.some((call) => String(call[0]) === lockPath);
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("lock exit identity", () => {
  async function holdLock(label: string): Promise<{
    manager: ReturnType<typeof createSidecarLockManager>;
    lockPath: string;
  }> {
    const base = await tempRoot(`fs-safe-lock-exit-identity-${label}-`);
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-lock-exit-identity-${label}`);
    await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 60_000,
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
    });
    return { manager, lockPath };
  }

  it("deletes a lock when Windows reports a stable known identity", async () => {
    const { manager, lockPath } = await holdLock("known");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    try {
      simulateWindows();
      exitCleanup()();
      expect(deletedLock(rmSync, lockPath)).toBe(true);
      expect(fsSync.existsSync(lockPath)).toBe(false);
    } finally {
      manager.reset();
    }
  });

  it("does not delete a lock when a later Windows device id is unknown", async () => {
    const { manager, lockPath } = await holdLock("path-device");
    const realLstatSync = fsSync.lstatSync.bind(fsSync);
    const realOpenSync = fsSync.openSync.bind(fsSync);
    const realFstatSync = fsSync.fstatSync.bind(fsSync);
    const realReadFileSync = fsSync.readFileSync.bind(fsSync);
    let lockLstats = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = realLstatSync(...args) as Stats;
      if (String(args[0]) !== lockPath) return stat;
      lockLstats += 1;
      return lockLstats === 1 ? stat : patchedStat(stat, 0);
    });
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => realOpenSync(...args));
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => realFstatSync(...args) as Stats);
    vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => realReadFileSync(...args));
    const rmSync = vi.spyOn(fsSync, "rmSync");
    try {
      simulateWindows();
      exitCleanup()();
      expect(lockLstats).toBeGreaterThanOrEqual(2);
      expect(fsSync.readFileSync).toHaveBeenCalled();
      expect(deletedLock(rmSync, lockPath)).toBe(false);
      expect(fsSync.existsSync(lockPath)).toBe(true);
    } finally {
      manager.reset();
    }
  });

  it("does not delete a lock when the opened descriptor device id is unknown", async () => {
    const { manager, lockPath } = await holdLock("fd-device");
    const realLstatSync = fsSync.lstatSync.bind(fsSync);
    const realOpenSync = fsSync.openSync.bind(fsSync);
    const realFstatSync = fsSync.fstatSync.bind(fsSync);
    const realReadFileSync = fsSync.readFileSync.bind(fsSync);
    let lockFd: number | undefined;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => realLstatSync(...args) as Stats);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = realOpenSync(...args);
      if (String(args[0]) === lockPath) lockFd = fd;
      return fd;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      const stat = realFstatSync(...args) as Stats;
      return args[0] === lockFd ? patchedStat(stat, 0) : stat;
    });
    vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => realReadFileSync(...args));
    const rmSync = vi.spyOn(fsSync, "rmSync");
    try {
      simulateWindows();
      exitCleanup()();
      expect(lockFd).toBeTypeOf("number");
      expect(deletedLock(rmSync, lockPath)).toBe(false);
      expect(fsSync.existsSync(lockPath)).toBe(true);
    } finally {
      manager.reset();
    }
  });
});
