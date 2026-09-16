import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { fileStoreSync } from "../src/file-store.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

itPosix.each([false, true].flatMap((privateMode) =>
  ["root", "component"].map((subject) => ({ privateMode, subject }))))(
  "repairs a matching $subject mode changed after its first receipt (private=$privateMode)",
  async ({ privateMode, subject }) => {
    const root = await tempRoot("fs-safe-sync-store-mode-race-");
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    await Promise.all([fs.chmod(root, 0o700), fs.chmod(nested, 0o700)]);
    const changedDirectory = subject === "root" ? root : nested;
    const lstat = fsSync.lstatSync.bind(fsSync);
    let changed = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      if (stat && !changed && String(args[0]) === changedDirectory && typeof stat.ino === "bigint") {
        changed = true;
        fsSync.chmodSync(changedDirectory, 0o777);
      }
      return stat;
    }) as typeof fsSync.lstatSync);

    fileStoreSync({ rootDir: root, private: privateMode, durable: false, dirMode: 0o700 })
      .write("nested/value", "private value");

    expect(changed).toBe(true);
    expect((await fs.stat(changedDirectory)).mode & 0o7777).toBe(0o700);
    await expect(fs.readFile(path.join(nested, "value"), "utf8")).resolves.toBe("private value");
  },
);
