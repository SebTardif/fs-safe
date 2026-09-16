import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIDECAR_PATH_SNAPSHOT_NAMES,
  registerSidecarPathSnapshot,
  selectSidecarPathSnapshotFixture,
} from "../benchmarks/sidecar-path-snapshot.mjs";
import { applyBenchmarkPrivateWindowsAcl } from "../benchmarks/windows-private-directory.mjs";

describe("sidecar benchmark fixture placement", () => {
  it("selects only an ordinary same-drive Windows fixture parent", () => {
    expect(selectSidecarPathSnapshotFixture({
      platform: "linux",
      cwd: "/work",
      workspace: "/tmp/fixture",
    })).toEqual({
      allocation: "runner-workspace-child",
      classification: "runner-workspace",
      parent: "/tmp/fixture",
    });
    expect(selectSidecarPathSnapshotFixture({
      platform: "win32",
      cwd: "C:\\work",
      workspace: "c:\\temp\\fixture",
    })).toEqual({
      allocation: "runner-workspace-child",
      classification: "runner-workspace",
      parent: "c:\\temp\\fixture",
    });
    expect(selectSidecarPathSnapshotFixture({
      platform: "win32",
      cwd: "D:\\work",
      workspace: "C:\\temp\\fixture",
    })).toEqual({
      allocation: "unique-cwd-child",
      classification: "cwd-same-drive-fallback",
      parent: "D:\\work",
    });
    expect(selectSidecarPathSnapshotFixture({
      platform: "win32",
      cwd: "D:\\work",
      workspace: "\\\\server\\share\\fixture",
    }).classification).toBe("cwd-same-drive-fallback");
    for (const cwd of ["\\\\server\\share\\work", "\\\\?\\C:\\work", "\\work", "relative"]) {
      expect(() => selectSidecarPathSnapshotFixture({
        platform: "win32",
        cwd,
        workspace: "C:\\temp\\fixture",
      })).toThrow("ordinary local-drive cwd");
    }
  });

  it("applies private Windows ACL commands with bounded hidden execution", () => {
    let requested;
    let invocation;
    const api = {
      createIcaclsResetCommand: (directory: string, options: unknown) => {
        requested = { directory, options };
        return { command: "icacls.exe", args: [directory, "/reset"] };
      },
    };
    applyBenchmarkPrivateWindowsAcl(api, "C:\\fixture", {
      platform: "win32",
      spawn: (command: string, args: string[], options: unknown) => {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });
    expect(requested).toEqual({ directory: "C:\\fixture", options: { isDir: true } });
    expect(invocation).toEqual({
      command: "icacls.exe",
      args: ["C:\\fixture", "/reset"],
      options: { windowsHide: true, timeout: 30_000, stdio: "ignore" },
    });
    expect(() => applyBenchmarkPrivateWindowsAcl(api, "C:\\fixture", {
      platform: "win32",
      spawn: () => ({ status: 1 }),
    })).toThrow("private Windows ACL");
    expect(() => applyBenchmarkPrivateWindowsAcl({
      createIcaclsResetCommand: () => undefined,
    }, "C:\\fixture", { platform: "win32" })).toThrow("Windows principal");
    expect(() => applyBenchmarkPrivateWindowsAcl({}, "/fixture", {
      platform: "linux",
      spawn: () => { throw new Error("must not spawn"); },
    })).not.toThrow();
  });

  it("owns a fallback fixture before ACL or canonicalization setup can fail", async () => {
    const fallbackParent = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-sidecar-fallback-owner-"));
    fs.writeFileSync(path.join(fallbackParent, "neighbor"), "unchanged");
    try {
      for (const stage of ["acl", "canonicalize"] as const) {
        const failure = new Error(`${stage} failed`);
        let cleanup: () => Promise<void> = async () => {};
        let allocated = "";
        expect(() => registerSidecarPathSnapshot({
          api: { createFileLockManager: () => { throw new Error("manager must not run"); } },
          workspace: "C:\\runner-temp",
          cwd: "D:\\harness",
          platform: "win32",
          register: () => { throw new Error("registration must not run"); },
          onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
          allocateFallback: () => {
            allocated = fs.mkdtempSync(path.join(fallbackParent, `${stage}-fixture-`));
            return allocated;
          },
          preparePrivateDirectory: () => {
            if (stage === "acl") throw failure;
          },
          canonicalizeFixture: () => { throw failure; },
        })).toThrow(failure);
        expect(fs.statSync(allocated).isDirectory()).toBe(true);
        await cleanup();
        expect(fs.existsSync(allocated)).toBe(false);
        expect(fs.readdirSync(fallbackParent)).toEqual(["neighbor"]);
        expect(fs.readFileSync(path.join(fallbackParent, "neighbor"), "utf8")).toBe("unchanged");
      }
    } finally {
      fs.rmSync(fallbackParent, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "registers every row in a private direct-cwd fallback and preserves its neighbor",
    async ({ skip }) => {
      const cwd = process.cwd();
      const cwdRoot = path.parse(cwd).root;
      if (!/^[A-Za-z]:[\\/]$/u.test(cwdRoot)) {
        skip();
        return;
      }
      const otherDrive = cwdRoot.slice(0, 2).toLowerCase() === "c:" ? "Z:" : "C:";
      const neighbor = fs.mkdtempSync(path.join(cwd, ".fs-safe-sidecar-neighbor-"));
      const sentinel = path.join(neighbor, "sentinel");
      fs.writeFileSync(sentinel, "unchanged");
      let cleanup: () => Promise<void> = async () => {};
      let fixture = "";
      const registrations: Array<{ name: string; options: Record<string, unknown> }> = [];
      try {
        registerSidecarPathSnapshot({
          api: {
            createFileLockManager: () => ({
              acquire: async () => { throw new Error("measurement must not run during setup"); },
              drain: async () => {},
              heldEntries: () => [],
            }),
          },
          workspace: `${otherDrive}\\synthetic-runner-temp`,
          register: (name: string, _run: unknown, options: Record<string, unknown>) => {
            registrations.push({ name, options });
          },
          onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
          preparePrivateDirectory: (directory: string) => {
            fixture = directory;
            expect(path.dirname(directory)).toBe(cwd);
            expect(path.basename(directory)).toMatch(/^\.fs-safe-sidecar-path-snapshot-/u);
            expect(fs.readdirSync(directory)).toEqual([]);
          },
        });
        expect(registrations.map(({ name }) => name)).toEqual(SIDECAR_PATH_SNAPSHOT_NAMES);
        expect(registrations.every(({ options }) => options.skip === undefined)).toBe(true);
        expect(registrations.every(({ options }) =>
          JSON.stringify(options.fixturePlacement) === JSON.stringify({
            classification: "cwd-same-drive-fallback",
            sameDrive: true,
          }))).toBe(true);
        expect(fs.readdirSync(fixture).sort()).toEqual(
          Array.from({ length: 8 }, (_, index) => `row-${index}`),
        );
        await cleanup();
        expect(fs.existsSync(fixture)).toBe(false);
        expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
      } finally {
        if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
        fs.rmSync(neighbor, { recursive: true, force: true });
      }
    },
  );
});
