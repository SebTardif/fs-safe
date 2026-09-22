import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { movePathToTrash } from "../src/trash.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

itPosix("rejects an outside symlink that points at a file inside an allowed root", async () => {
  const sandbox = await tempRoot("fs-safe-trash-pointer-sandbox-");
  const outside = await tempRoot("fs-safe-trash-pointer-outside-");
  vi.spyOn(os, "homedir").mockReturnValue(sandbox);
  const inside = path.join(sandbox, "inside.txt");
  const pointer = path.join(outside, "pointer");
  await fs.writeFile(inside, "inside bytes");
  await fs.symlink(inside, pointer);

  await expect(movePathToTrash(pointer, { allowedRoots: [sandbox] })).rejects.toThrow(
    "outside allowed roots",
  );
  expect((await fs.lstat(pointer)).isSymbolicLink()).toBe(true);
  await expect(fs.readFile(inside, "utf8")).resolves.toBe("inside bytes");
});

itPosix("rejects a dangling symlink reached through an in-root symlink directory", async () => {
  const sandbox = await tempRoot("fs-safe-trash-hop-sandbox-");
  const outside = await tempRoot("fs-safe-trash-hop-outside-");
  vi.spyOn(os, "homedir").mockReturnValue(sandbox);
  const nested = path.join(outside, "nested");
  const realdir = path.join(nested, "realdir");
  const broken = path.join(realdir, "broken");
  await fs.mkdir(realdir, { recursive: true });
  await fs.symlink(path.join(realdir, "missing"), broken);
  await fs.symlink(nested, path.join(sandbox, "hop"), "dir");

  const reached = path.join(sandbox, "hop", "realdir", "broken");
  await expect(movePathToTrash(reached, { allowedRoots: [sandbox] })).rejects.toThrow(
    "outside allowed roots",
  );
  expect((await fs.lstat(broken)).isSymbolicLink()).toBe(true);
  await expect(fs.readlink(broken)).resolves.toBe(path.join(realdir, "missing"));
});

itPosix("trashes a symlink whose own parent stays inside an allowed root", async () => {
  const sandbox = await tempRoot("fs-safe-trash-inner-link-sandbox-");
  const outside = await tempRoot("fs-safe-trash-inner-link-outside-");
  vi.spyOn(os, "homedir").mockReturnValue(sandbox);
  const outsideFile = path.join(outside, "secret.txt");
  const link = path.join(sandbox, "link");
  await fs.writeFile(outsideFile, "secret");
  await fs.symlink(outsideFile, link);

  const destination = await movePathToTrash(link, { allowedRoots: [sandbox] });
  await expect(fs.readlink(destination)).resolves.toBe(outsideFile);
  await expect(fs.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("secret");
});

it("trashes a normal file inside an allowed root", async () => {
  const sandbox = await tempRoot("fs-safe-trash-contained-file-");
  vi.spyOn(os, "homedir").mockReturnValue(sandbox);
  const source = path.join(sandbox, "note.txt");
  await fs.writeFile(source, "contained bytes");

  const destination = await movePathToTrash(source, { allowedRoots: [sandbox] });
  await expect(fs.readFile(destination, "utf8")).resolves.toBe("contained bytes");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});
