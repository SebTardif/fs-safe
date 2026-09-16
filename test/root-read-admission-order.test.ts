import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

async function admissionFixture(prefix: string) {
  const base = await tempRoot(prefix);
  const active = path.join(base, "root");
  const relativePath = "value";
  const filePath = path.join(active, relativePath);
  await fs.mkdir(active);
  await fs.writeFile(filePath, "original");
  const scoped = await root(active);
  return { active, filePath, relativePath, scoped };
}

function observeOpenedHandle(filePath: string) {
  let handle: FileHandle | undefined;
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let read: ReturnType<typeof vi.spyOn> | undefined;
  let readFile: ReturnType<typeof vi.spyOn> | undefined;
  return {
    hook(candidate: string, opened: FileHandle) {
      if (candidate !== filePath) return;
      handle = opened;
      close = vi.spyOn(opened, "close");
      read = vi.spyOn(opened, "read");
      readFile = vi.spyOn(opened, "readFile");
    },
    get handle() {
      return handle;
    },
    get close() {
      return close;
    },
    get read() {
      return read;
    },
    get readFile() {
      return readFile;
    },
  };
}

itPosix.each(["reject", "follow-parents-within-root", "follow-within-root"] as const)(
  "admits one descriptor through the ordered final observations (%s)",
  async (symlinks) => {
    const fixture = await admissionFixture("fs-safe-root-read-admission-order-");
    const observed = observeOpenedHandle(fixture.filePath);
    const phases: string[] = [];
    let recording = false;
    let rootObservations = 0, yieldedInsideFence = false;
    const open = vi.spyOn(fs, "open");
    for (const operation of ["lstatSync", "statSync"] as const) {
      const actual = fsSync[operation].bind(fsSync);
      vi.spyOn(fsSync, operation).mockImplementation((...args) => {
        if (recording) {
          expect(args[1]?.bigint).toBe(true);
          if (String(args[0]) === fixture.active) {
            expect(yieldedInsideFence).toBe(false);
            if (++rootObservations === 1) queueMicrotask(() => { yieldedInsideFence = true; });
          }
          phases.push(String(args[0]) === fixture.active
            ? "root" : operation === "lstatSync" ? "path:nofollow" : "path:follow");
        }
        return actual(...args);
      });
    }
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      if (recording) phases.push(args[1]?.bigint ? "descriptor:bigint" : "descriptor:numeric");
      return fstat(...args);
    });
    const realpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
      if (recording) {
        expect(String(args[0])).toBe(fixture.filePath);
        phases.push("realpath");
      }
      return realpath(...args);
    });
    const genericAdmission = vi.fn();
    __setFsSafeTestHooksForTest({
      afterRootReadPathResolution() { recording = true; },
      afterOpen(candidate, handle) {
        observed.hook(candidate, handle);
        phases.push("open");
      },
      afterOpenedPathIdentityCheck: genericAdmission,
      beforeRootReadFinalFence() { phases.push("final"); },
      afterRootReadFinalPathIdentityCheck() { phases.push("canonical:admitted"); },
    });

    const result = await fixture.scoped.open(fixture.relativePath, { symlinks });
    recording = false;
    try {
      expect(phases).toEqual([
        "path:nofollow", "open", "descriptor:numeric", "descriptor:bigint", "final",
        "root", symlinks === "follow-within-root" ? "path:follow" : "path:nofollow",
        "realpath", "path:nofollow", "canonical:admitted", "root",
      ]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(rootObservations).toBe(2);
      expect(genericAdmission).not.toHaveBeenCalled();
      expect(result.realPath).toBe(fixture.filePath);
      expect(result.handle).toBe(observed.handle);
      expect(observed.close).not.toHaveBeenCalled();
      expect(observed.read).not.toHaveBeenCalled();
      expect(observed.readFile).not.toHaveBeenCalled();
    } finally {
      await result.handle.close();
    }
    expect(observed.close).toHaveBeenCalledTimes(1);
  },
);

itPosix.each(["beforeRootReadFinalFence", "afterRootReadFinalPathIdentityCheck"] as const)(
  "closes exactly once without reading when %s throws",
  async (hook) => {
    const fixture = await admissionFixture("fs-safe-root-read-hook-failure-");
    const observed = observeOpenedHandle(fixture.filePath);
    const failure = new Error("injected admission hook failure");
    __setFsSafeTestHooksForTest({
      afterOpen: observed.hook,
      [hook]() { throw failure; },
    });

    await expect(fixture.scoped.readText(fixture.relativePath)).rejects.toBe(failure);
    expect(observed.handle?.fd).toBe(-1);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
  },
);
