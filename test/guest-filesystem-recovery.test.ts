import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const FORCE_EXDEV = `
_test_original_rename = os.rename
def _test_after_publication():
    pass
def _test_rename(source, destination, *args, **kwargs):
    if source == sys.argv[4] and destination == sys.argv[7]:
        raise OSError(errno.EXDEV, 'forced cross-device rename')
    result = _test_original_rename(source, destination, *args, **kwargs)
    if destination == sys.argv[7]:
        _test_after_publication()
    return result
os.rename = _test_rename
`;

// Exercise zero-mode branches on unprivileged hosts. This injection is not
// evidence that the unmodified guest can read an inaccessible source.
const OPEN_ZERO_MODE_DIRECTORIES = `
import stat
_test_original_open = os.open
def _test_open_zero(path, flags, mode=0o777, *, dir_fd=None):
    try:
        return _test_original_open(path, flags, mode, dir_fd=dir_fd)
    except PermissionError:
        if dir_fd is None:
            raise
        observed = os.lstat(path, dir_fd=dir_fd)
        if not stat.S_ISDIR(observed.st_mode) or stat.S_IMODE(observed.st_mode) != 0:
            raise
        os.chmod(path, 0o700, dir_fd=dir_fd, follow_symlinks=False)
        try:
            return _test_original_open(path, flags, mode, dir_fd=dir_fd)
        finally:
            os.chmod(path, 0, dir_fd=dir_fd, follow_symlinks=False)
os.open = _test_open_zero
`;

describe.skipIf(process.platform === "win32")("guest filesystem cross-device recovery", () => {
  const { tempRoot } = useRealTempDirs();

  async function fixture(payload: Buffer | string = "payload") {
    const directory = await tempRoot("fs-safe-guest-recovery-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(path.join(source, "tree", "nested"), { recursive: true });
    await fs.mkdir(destination);
    await fs.writeFile(path.join(source, "tree", "nested", "file.txt"), payload);
    return {
      directory,
      source,
      destination,
      args: ["rename", source, "", "tree", destination, "", "moved", "1"],
    };
  }

  async function zeroModeFixture(nested = false) {
    const directory = await tempRoot("fs-safe-guest-zero-mode-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    const zero = path.join(source, "tree", ...(nested ? ["child"] : []));
    await fs.mkdir(zero, { recursive: true });
    await fs.chmod(zero, 0);
    await fs.mkdir(destination);
    return {
      source, destination, zero,
      args: ["rename", source, "", "tree", destination, "", "moved", "0"],
    };
  }

  async function restoreDirectories(paths: string[]) {
    for (const target of paths) {
      await fs.chmod(target, 0o700).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  it.each([false, true])("preserves zero mode with injected directory opens (nested=%s)", async (nested) => {
    const { source, destination, zero, args } = await zeroModeFixture(nested);
    const copiedZero = path.join(destination, "moved", ...(nested ? ["child"] : []));
    try {
      const result = runGuest(args, undefined, `${FORCE_EXDEV}\n${OPEN_ZERO_MODE_DIRECTORIES}`);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(0);
      expect((await fs.stat(copiedZero)).mode & 0o777).toBe(0);
      expect(await fs.readdir(source)).toEqual([]);
      expect(await fs.readdir(destination)).toEqual(["moved"]);
    } finally {
      await restoreDirectories([zero, copiedZero]);
    }
  });

  it.skipIf(process.getuid?.() === 0).each([false, true])("rejects an inaccessible zero-mode source without widening it (nested=%s)", async (nested) => {
    const { destination, zero, args } = await zeroModeFixture(nested);
    try {
      const result = runGuest(args, undefined, FORCE_EXDEV);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain("PermissionError");
      expect((await fs.stat(zero)).mode & 0o777).toBe(0);
      expect(await fs.readdir(destination)).toEqual([]);
    } finally {
      await restoreDirectories([zero]);
      for (const name of await fs.readdir(destination)) {
        await restoreDirectories([path.join(destination, name), ...(nested ? [path.join(destination, name, "child")] : [])]);
      }
    }
  });

  it.each([0o022, 0o077])("keeps nonzero directory modes subject to umask %s", async (umask) => {
    const { source, destination, args } = await fixture();
    await fs.chmod(path.join(source, "tree"), 0o755);
    await fs.chmod(path.join(source, "tree", "nested"), 0o755);
    const result = runGuest(args, undefined, `${FORCE_EXDEV}\nos.umask(${umask})`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect((await fs.stat(path.join(destination, "moved"))).mode & 0o777).toBe(0o755 & ~umask);
    expect((await fs.stat(path.join(destination, "moved", "nested"))).mode & 0o777).toBe(0o755 & ~umask);
    expect(await fs.readdir(source)).toEqual([]);
  });

  it.each([{ before: 0, admitted: 0o755 }, { before: 0o755, admitted: 0 }])(
    "uses the admitted source mode after $before changes to $admitted before open",
    async ({ before, admitted }) => {
      const { source, destination, zero, args } = await zeroModeFixture();
      await fs.chmod(zero, before);
      const copied = path.join(destination, "moved");
      const setup = `${FORCE_EXDEV}\n${OPEN_ZERO_MODE_DIRECTORIES}
os.umask(0o022)
_test_open_before_change = os.open
_test_mode_changed = False
def _test_change_source_mode(path, flags, mode=0o777, *, dir_fd=None):
    global _test_mode_changed
    if not _test_mode_changed and path == sys.argv[4] and dir_fd is not None:
        _test_mode_changed = True
        os.chmod(path, ${admitted}, dir_fd=dir_fd, follow_symlinks=False)
    return _test_open_before_change(path, flags, mode, dir_fd=dir_fd)
os.open = _test_change_source_mode
`;
      try {
        const result = runGuest(args, undefined, setup);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr.toString()).toBe(0);
        expect((await fs.stat(copied)).mode & 0o777).toBe(admitted);
        expect(await fs.readdir(source)).toEqual([]);
        expect(await fs.readdir(destination)).toEqual(["moved"]);
      } finally {
        await restoreDirectories([zero, copied]);
      }
    },
  );

  it.each([false, true])("leaves replacement entries untouched when zero-mode fchmod fails=%s", async (fail) => {
    const { source, destination, zero, args } = await zeroModeFixture();
    const retained = path.join(destination, "retained-published");
    const moved = path.join(destination, "moved");
    const setup = `${FORCE_EXDEV}\n${OPEN_ZERO_MODE_DIRECTORIES}
import atexit
_test_staging_name = None
_test_staging_fd = None
_test_original_fchmod = os.fchmod
def _test_after_publication():
    global _test_staging_name
    _test_original_rename(os.path.join(sys.argv[5], sys.argv[7]), os.path.join(sys.argv[5], 'retained-published'))
    for name in (sys.argv[7], _test_staging_name):
        replacement = os.path.join(sys.argv[5], name)
        os.mkdir(replacement, 0o700)
        with open(os.path.join(replacement, 'competitor.txt'), 'w') as output:
            output.write('unrelated competitor')
_test_forced_rename = os.rename
def _test_remember_staging(source, destination, *args, **kwargs):
    global _test_staging_name
    if destination == sys.argv[7] and source != sys.argv[4]:
        _test_staging_name = source
    return _test_forced_rename(source, destination, *args, **kwargs)
os.rename = _test_remember_staging
def _test_fchmod(fd, mode):
    global _test_staging_fd
    _test_staging_fd = fd
    observed = os.fstat(fd)
    retained = os.stat(os.path.join(sys.argv[5], 'retained-published'))
    assert (observed.st_dev, observed.st_ino) == (retained.st_dev, retained.st_ino)
    sys.stderr.write('retained descriptor selected\\n')
    ${fail ? "raise OSError(errno.EPERM, 'injected fchmod failure')" : "return _test_original_fchmod(fd, mode)"}
os.fchmod = _test_fchmod
def _test_verify_closed():
    if _test_staging_fd is None:
        return
    try:
        os.fstat(_test_staging_fd)
    except OSError as error:
        if error.errno == errno.EBADF:
            sys.stderr.write('retained descriptor closed\\n')
atexit.register(_test_verify_closed)
`;
    try {
      const result = runGuest(args, undefined, setup);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(fail ? 1 : 0);
      expect(result.stderr.toString()).toContain("retained descriptor selected");
      expect(result.stderr.toString()).toContain("retained descriptor closed");
      if (fail) expect(result.stderr.toString()).toContain("injected fchmod failure");
      expect((await fs.stat(retained)).mode & 0o777).toBe(fail ? 0o700 : 0);
      expect(await fs.readdir(source)).toEqual(fail ? ["tree"] : []);
      const entries = (await fs.readdir(destination)).sort();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatch(/^\.openclaw-move-/);
      expect(entries.slice(1)).toEqual(["moved", "retained-published"]);
      for (const entry of [entries[0]!, "moved"]) {
        const replacement = path.join(destination, entry);
        expect((await fs.stat(replacement)).mode & 0o777).toBe(0o700);
        expect(await fs.readdir(replacement)).toEqual(["competitor.txt"]);
        expect(await fs.readFile(path.join(replacement, "competitor.txt"), "utf8")).toBe("unrelated competitor");
      }
    } finally {
      await restoreDirectories([zero, moved, retained]);
    }
  });

  it("publishes a directory with a long destination basename before removing its source after EXDEV", async () => {
    const payload = Buffer.alloc(65_573, 0x6b);
    const { source, destination, args } = await fixture(payload);
    const basename = "d".repeat(240);
    args[6] = basename;
    await fs.chmod(path.join(source, "tree", "nested", "file.txt"), 0o751);
    await fs.symlink("nested/file.txt", path.join(source, "tree", "alias"));

    const result = runGuest(args, undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(path.join(destination, basename, "nested", "file.txt"))).toEqual(payload);
    expect((await fs.stat(path.join(destination, basename, "nested", "file.txt"))).mode & 0o777).toBe(0o751);
    expect(await fs.readlink(path.join(destination, basename, "alias"))).toBe("nested/file.txt");
    expect(await fs.readdir(source)).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([basename]);
  });

  it("atomically replaces a long destination basename during a file move after EXDEV", async () => {
    const payload = Buffer.alloc(65_573, 0x6b);
    const { source, destination } = await fixture(payload);
    const basename = "f".repeat(240);
    const sourceFile = path.join(source, "tree", "nested", "file.txt");
    const destinationFile = path.join(destination, basename);
    await fs.chmod(sourceFile, 0o751);
    await fs.writeFile(destinationFile, "previous");

    const result = runGuest([
      "rename", source, "tree/nested", "file.txt", destination, "", basename, "0",
    ], undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(destinationFile)).toEqual(payload);
    expect((await fs.stat(destinationFile)).mode & 0o777).toBe(0o751);
    expect(await fs.readdir(path.dirname(sourceFile))).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([basename]);
  });

  it("retains the source and removes destination staging when a copied child is hardlinked", async () => {
    const { directory, source, destination, args } = await fixture();
    const retained = path.join(directory, "retained.txt");
    await fs.writeFile(retained, "retained data");
    await fs.link(retained, path.join(source, "tree", "nested", "linked.txt"));

    const result = runGuest(args, undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("hardlinked file is not allowed");
    expect(await fs.readFile(path.join(source, "tree", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "nested", "linked.txt"), "utf8")).toBe("retained data");
    expect(await fs.readFile(retained, "utf8")).toBe("retained data");
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it.each(["symlink", "replace"])("preserves both entries when symlink move %s fails after EXDEV", async (operation) => {
    const { source, destination } = await fixture();
    await fs.symlink("missing-target", path.join(source, "alias"));
    await fs.writeFile(path.join(destination, "moved"), "previous");
    const setup = `${FORCE_EXDEV}
def fail_move(*args, **kwargs):
    raise OSError(errno.ENOSPC, 'injected symlink move failure')
os.${operation} = fail_move
`;

    const result = runGuest([
      "rename", source, "", "alias", destination, "", "moved", "0",
    ], undefined, setup);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("injected symlink move failure");
    expect(await fs.readlink(path.join(source, "alias"))).toBe("missing-target");
    expect(await fs.readFile(path.join(destination, "moved"), "utf8")).toBe("previous");
    expect(await fs.readdir(destination)).toEqual(["moved"]);
  });

  it.each(["file", "symlink"])("replaces an existing %s with a symlink after EXDEV", async (kind) => {
    const { source, destination } = await fixture();
    const basename = "s".repeat(240);
    await fs.symlink("missing-target", path.join(source, "alias"));
    if (kind === "file") await fs.writeFile(path.join(destination, basename), "previous");
    else await fs.symlink("previous-target", path.join(destination, basename));

    const result = runGuest([
      "rename", source, "", "alias", destination, "", basename, "0",
    ], undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readlink(path.join(destination, basename))).toBe("missing-target");
    await expect(fs.lstat(path.join(source, "alias"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(destination)).toEqual([basename]);
  });

  it("retains the published copy and source when a file is added after copying", async () => {
    const { source, destination, args } = await fixture();
    await fs.utimes(path.join(source, "tree"), 1, 1);
    const setup = `${FORCE_EXDEV}
def _test_after_publication():
    source_tree = os.path.join(sys.argv[2], sys.argv[3], sys.argv[4])
    with open(os.path.join(source_tree, 'late.txt'), 'xb') as late:
        late.write(b'late data')
`;

    const result = runGuest(args, undefined, setup);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("source changed during move fallback cleanup");
    expect(await fs.readFile(path.join(destination, "moved", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "late.txt"), "utf8")).toBe("late data");
    expect(await fs.readdir(path.join(destination, "moved"))).toEqual(["nested"]);
    expect(await fs.readdir(destination)).toEqual(["moved"]);
  });

  it("retains the published copy and replacement when a copied source file is replaced", async () => {
    const { source, destination, args } = await fixture();
    const setup = `${FORCE_EXDEV}
def _test_after_publication():
    source_directory = os.path.join(sys.argv[2], sys.argv[3], sys.argv[4], 'nested')
    replacement = os.path.join(source_directory, 'replacement.txt')
    with open(replacement, 'xb') as output:
        output.write(b'replacement data')
    os.replace(replacement, os.path.join(source_directory, 'file.txt'))
`;

    const result = runGuest(args, undefined, setup);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("source changed during move fallback cleanup");
    expect(await fs.readFile(path.join(destination, "moved", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "nested", "file.txt"), "utf8")).toBe("replacement data");
    expect(await fs.readdir(path.join(source, "tree", "nested"))).toEqual(["file.txt"]);
    expect(await fs.readdir(destination)).toEqual(["moved"]);
  });
});
