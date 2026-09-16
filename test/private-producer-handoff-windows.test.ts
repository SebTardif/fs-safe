import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertSyncDirectoryGuard, createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { handoffPrivateProducerFile } from "../src/private-producer-handoff.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const handles = new Set<FileHandle>();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const handle of handles) await handle.close().catch(() => undefined);
  handles.clear();
  __cleanupRegisteredTempPathsForTest();
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function fixture(readWrite = false, readOnly = false) {
  const dir = await tempRoot("fs-safe-handoff-windows-");
  const workspace = path.join(dir, "private");
  const source = path.join(workspace, "source");
  const target = path.join(dir, "sibling");
  await fs.mkdir(workspace);
  await fs.writeFile(source, "producer");
  if (readOnly) await fs.chmod(source, 0o444);
  const identity = await fs.lstat(source, { bigint: true });
  const sourceParent = await createAsyncDirectoryGuard(workspace, { bigint: true });
  const targetParent = await createAsyncDirectoryGuard(dir, { bigint: true });
  const run = () => handoffPrivateProducerFile({
    sourcePath: source,
    targetPath: target,
    readWrite,
    assertSourceParent: () => assertSyncDirectoryGuard(sourceParent),
    assertTargetParent: () => assertSyncDirectoryGuard(targetParent),
  });
  return { dir, workspace, source, target, identity, run };
}

function observeOpens(observe: (
  file: string,
  flags: string | number,
  handle: FileHandle,
) => Promise<void> | void) {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    handles.add(handle);
    await observe(String(args[0]), args[1], handle);
    return handle;
  });
}

it.each([false, true])("transfers the Windows pin before retiring the private name (sync=%s)", async readWrite => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture(readWrite);
  let sourceHandle: FileHandle | undefined;
  let siblingHandle: FileHandle | undefined;
  let sourceClosed = false;
  const events: string[] = [];
  observeOpens((file, _flags, handle) => {
    if (file === f.source) {
      sourceHandle = handle;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        expect(siblingHandle).toBeDefined();
        expect(fsSync.fstatSync(siblingHandle!.fd, { bigint: true })).toMatchObject({
          dev: f.identity.dev, ino: f.identity.ino, nlink: 2n,
        });
        await close();
        sourceClosed = true;
        events.push("source closed");
      });
    } else if (file === f.target) {
      siblingHandle = handle;
      expect(sourceHandle!.fd).toBeGreaterThanOrEqual(0);
      expect(fsSync.fstatSync(sourceHandle!.fd, { bigint: true })).toMatchObject({
        dev: f.identity.dev, ino: f.identity.ino, nlink: 2n,
      });
      events.push("sibling opened with source pinned");
    }
  });
  const unlink = fsSync.unlinkSync.bind(fsSync);
  vi.spyOn(fsSync, "unlinkSync").mockImplementation(file => {
    if (String(file) === f.source) {
      // Legacy Windows leaves this name delete-pending if its source handle is open.
      expect(sourceClosed).toBe(true);
      expect(fsSync.fstatSync(siblingHandle!.fd, { bigint: true })).toMatchObject({
        dev: f.identity.dev, ino: f.identity.ino, nlink: 2n,
      });
      events.push("source unlinked with sibling pinned");
    }
    unlink(file);
  });

  const handoff = await f.run();
  expect(handoff.handle).toBe(siblingHandle);
  expect(events).toEqual([
    "sibling opened with source pinned", "source closed", "source unlinked with sibling pinned",
  ]);
  await fs.rmdir(f.workspace);
  expect(fsSync.fstatSync(handoff.handle.fd, { bigint: true })).toMatchObject({
    dev: f.identity.dev, ino: f.identity.ino, nlink: 1n,
  });
  expect(await fs.readFile(f.target, "utf8")).toBe("producer");
  handoff.unregister();
});

it.each([false, true])("uses the two-link receipt throughout sibling access fallback (sync=%s)", async readWrite => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture(readWrite);
  let sourceHandle: FileHandle | undefined;
  let provisionalFd = -1;
  let fallbackHandle: FileHandle | undefined;
  let deniedMetadata = false;
  const flags: (string | number)[] = [];
  observeOpens((file, access, handle) => {
    if (file === f.source) sourceHandle = handle;
    if (file !== f.target) return;
    flags.push(access);
    expect(sourceHandle!.fd).toBeGreaterThanOrEqual(0);
    if (access === fsSync.constants.O_WRONLY) {
      provisionalFd = handle.fd;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        expect(fallbackHandle).toBeDefined();
        expect(sourceHandle!.fd).toBeGreaterThanOrEqual(0);
        expect(fsSync.fstatSync(fallbackHandle!.fd, { bigint: true }).nlink).toBe(2n);
        await close();
      });
    } else fallbackHandle = handle;
  });
  const fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    if (!deniedMetadata && args[0] === provisionalFd) {
      deniedMetadata = true;
      throw errno("EPERM");
    }
    return fstat(...args);
  });

  const handoff = await f.run();
  expect(deniedMetadata).toBe(true);
  expect(flags).toEqual([fsSync.constants.O_WRONLY, readWrite ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY]);
  expect(handoff.handle).toBe(fallbackHandle);
  expect(sourceHandle!.fd).toBe(-1);
  expect(fsSync.fstatSync(handoff.handle.fd, { bigint: true }).nlink).toBe(1n);
  expect(await fs.readdir(f.workspace)).toEqual([]);
  handoff.unregister();
});

it("rechecks the source name after its handle close yields", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture();
  const saved = path.join(f.workspace, "saved-source");
  observeOpens((file, _flags, handle) => {
    if (file !== f.source) return;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await close();
      await fs.rename(f.source, saved);
      await fs.writeFile(f.source, "replacement");
    });
  });
  const unlink = vi.spyOn(fsSync, "unlinkSync");

  await expect(f.run()).rejects.toMatchObject({ code: "path-mismatch" });
  expect(unlink).not.toHaveBeenCalledWith(f.source);
  expect(await fs.readFile(f.source, "utf8")).toBe("replacement");
  expect(await fs.readFile(saved, "utf8")).toBe("producer");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect([...handles].every(handle => handle.fd === -1)).toBe(true);
});

it("preserves a competing sibling substituted while its descriptor opens", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture();
  const saved = path.join(f.dir, "saved-sibling");
  observeOpens(async (file) => {
    if (file !== f.target) return;
    await fs.rename(f.target, saved);
    await fs.writeFile(f.target, "competitor");
  });
  const unlink = vi.spyOn(fsSync, "unlinkSync");

  const failure = await f.run().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([
    expect.objectContaining({ code: "path-mismatch" }),
    expect.objectContaining({ code: "path-mismatch" }),
  ]);
  expect(unlink).not.toHaveBeenCalledWith(f.source);
  expect(unlink).not.toHaveBeenCalledWith(f.target);
  expect(await fs.readFile(f.source, "utf8")).toBe("producer");
  expect(await fs.readFile(f.target, "utf8")).toBe("competitor");
  expect(await fs.readFile(saved, "utf8")).toBe("producer");
  expect([...handles].every(handle => handle.fd === -1)).toBe(true);
});

it("settles both pins without retiring the source when its first close fails", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture();
  const failed = new Error("source close failed");
  let closeAttempts = 0;
  observeOpens((file, _flags, handle) => {
    if (file !== f.source) return;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      if (++closeAttempts === 1) throw failed;
      await close();
    });
  });
  const unlink = vi.spyOn(fsSync, "unlinkSync");

  await expect(f.run()).rejects.toBe(failed);
  expect(closeAttempts).toBe(2);
  expect(unlink).not.toHaveBeenCalledWith(f.source);
  expect(await fs.readFile(f.source, "utf8")).toBe("producer");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect([...handles].every(handle => handle.fd === -1)).toBe(true);
});

it("retains source-close and both settlement failures", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture();
  const failed = new Error("source close failed");
  const siblingSettlement = new Error("sibling settlement failed");
  const sourceSettlement = new Error("source settlement failed");
  let sourceCloseAttempts = 0;
  observeOpens((file, _flags, handle) => {
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      if (file === f.source && ++sourceCloseAttempts === 1) throw failed;
      await close();
      throw file === f.target ? siblingSettlement : sourceSettlement;
    });
  });

  const failure = await f.run().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([failed, siblingSettlement, sourceSettlement]);
  expect(await fs.readFile(f.source, "utf8")).toBe("producer");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect([...handles].every(handle => handle.fd === -1)).toBe(true);
});

function emulateLegacyReadOnlyUnlink(source: string): void {
  const unlink = fsSync.unlinkSync.bind(fsSync);
  vi.spyOn(fsSync, "unlinkSync").mockImplementation(file => {
    if (String(file) === source) fsSync.chmodSync(file, 0o666);
    unlink(file);
  });
}

it("restores a read-only attribute cleared by legacy unlink through the retained sibling pin", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture(false, true);
  let siblingHandle: FileHandle | undefined;
  observeOpens((file, _flags, handle) => { if (file === f.target) siblingHandle = handle; });
  emulateLegacyReadOnlyUnlink(f.source);
  const chmod = fsSync.fchmodSync.bind(fsSync);
  const repair = vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
    expect(fd).toBe(siblingHandle!.fd);
    expect(fsSync.fstatSync(fd, { bigint: true })).toMatchObject({
      dev: f.identity.dev, ino: f.identity.ino, nlink: 1n,
    });
    expect(fsSync.lstatSync(f.target, { bigint: true })).toMatchObject({
      dev: f.identity.dev, ino: f.identity.ino, nlink: 1n,
    });
    chmod(fd, mode);
  });

  const handoff = await f.run();
  expect(repair).toHaveBeenCalledOnce();
  expect(repair).toHaveBeenCalledWith(handoff.handle.fd, 0o444);
  expect(fsSync.fstatSync(handoff.handle.fd, { bigint: true }).mode & 0o777n).toBe(0o444n);
  expect((await fs.lstat(f.target, { bigint: true })).mode & 0o777n).toBe(0o444n);
  expect(await fs.readFile(f.target, "utf8")).toBe("producer");
  await fs.rmdir(f.workspace);
  handoff.unregister();
});

it.each(["denied", "ineffective"] as const)("fails closed when read-only restoration is %s", async outcome => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture(false, true);
  observeOpens(() => undefined);
  emulateLegacyReadOnlyUnlink(f.source);
  const denied = errno("EPERM");
  const repair = vi.spyOn(fsSync, "fchmodSync").mockImplementation(() => {
    if (outcome === "denied") throw denied;
  });

  const failure = await f.run().catch(error => error);
  if (outcome === "denied") expect(failure).toBe(denied);
  else expect(failure).toMatchObject({ code: "path-mismatch" });
  expect(repair).toHaveBeenCalledOnce();
  await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect([...handles].every(handle => handle.fd === -1)).toBe(true);
});

it("preserves a sibling replacement observed after descriptor mode restoration", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const f = await fixture(false, true);
  const saved = path.join(f.dir, "saved-sibling");
  observeOpens(() => undefined);
  emulateLegacyReadOnlyUnlink(f.source);
  const chmod = fsSync.fchmodSync.bind(fsSync);
  vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
    chmod(fd, mode);
    fsSync.renameSync(f.target, saved);
    fsSync.writeFileSync(f.target, "competitor");
  });

  const failure = await f.run().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([
    expect.objectContaining({ code: "path-mismatch" }),
    expect.objectContaining({ code: "path-mismatch" }),
  ]);
  expect(await fs.readFile(f.target, "utf8")).toBe("competitor");
  expect(await fs.readFile(saved, "utf8")).toBe("producer");
  expect((await fs.lstat(saved, { bigint: true })).mode & 0o777n).toBe(0o444n);
  expect([...handles].every(handle => handle.fd === -1)).toBe(true);
});
