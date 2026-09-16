import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import {
  registerTempPathForExit,
  type TempPathRegistration,
} from "./temp-cleanup.js";

export type PrivateProducerHandoff = {
  handle: FileHandle;
  identity: BigIntStats;
  unregister: TempPathRegistration;
};

type HandoffState = {
  siblingOwned: boolean;
};

type HandoffParents = {
  assertSourceParent: () => void;
  assertTargetParent: () => void;
};

function pathMismatch(message: string): FsSafeError {
  return new FsSafeError("path-mismatch", message);
}

function assertInitialSource(stat: BigIntStats): void {
  if (stat.isSymbolicLink()) {
    throw new FsSafeError("path-alias", "isolated producer output must not be a symlink");
  }
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", "isolated producer output must be a regular file");
  }
  if (stat.nlink !== 1n) {
    throw new FsSafeError("hardlink", "isolated producer output must have exactly one link");
  }
}

function inspectLinkedFile(
  inspect: () => BigIntStats,
  expected: BigIntStats,
  links: bigint,
  label: string,
): BigIntStats {
  return inspectFileIdentitySync(() => {
    const stat = inspect();
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== links) {
      throw pathMismatch(`${label} changed during isolated producer handoff`);
    }
    return stat;
  }, expected);
}

function assertParents(params: HandoffParents): void {
  params.assertTargetParent();
  params.assertSourceParent();
}

function normalizeLinkError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST") {
    return new FsSafeError("already-exists", "isolated producer sibling already exists", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    code === "EXDEV" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EPERM"
  ) {
    return new FsSafeError("helper-unavailable", "atomic isolated producer handoff is unavailable", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

function removeSiblingIfOwned(params: {
  assertTargetParent: () => void;
  identity: BigIntStats;
  state: HandoffState;
  targetPath: string;
}): void {
  if (!params.state.siblingOwned) return;
  params.assertTargetParent();
  let current: BigIntStats;
  try {
    current = fsSync.lstatSync(params.targetPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      params.state.siblingOwned = false;
      return;
    }
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    (current.nlink !== 1n && current.nlink !== 2n) ||
    !sameFileIdentityForCleanup(current, params.identity)
  ) {
    throw pathMismatch("isolated producer sibling changed before cleanup");
  }
  fsSync.unlinkSync(params.targetPath);
  params.state.siblingOwned = false;
  params.assertTargetParent();
}

function combinedFailure(primary: unknown, settlement: readonly unknown[]): unknown {
  if (settlement.length === 0) return primary;
  return new AggregateError(
    [primary, ...settlement],
    "isolated producer handoff and settlement failed",
  );
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return !(error instanceof FsSafeError) &&
    codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

async function throwAfterClosing(
  primary: unknown,
  handles: readonly (FileHandle | undefined)[],
): Promise<never> {
  const settlement: unknown[] = [];
  const closed = new Set<FileHandle>();
  for (const handle of handles) {
    if (!handle || closed.has(handle)) continue;
    closed.add(handle);
    try {
      await handle.close();
    } catch (error) {
      settlement.push(error);
    }
  }
  throw combinedFailure(primary, settlement);
}

function inspectSourceDescriptor(handle: FileHandle, identity: BigIntStats, links = 1n): void {
  inspectLinkedFile(
    () => fsSync.fstatSync(handle.fd, { bigint: true }),
    identity,
    links,
    "isolated producer descriptor",
  );
}

function historicalOpenFlags(readWrite: boolean): number {
  const access = readWrite ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY;
  return access | resolveReadOpenFlags();
}

async function openHistoricalSource(
  sourcePath: string,
  identity: BigIntStats,
  readWrite: boolean,
  links: bigint,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(sourcePath, historicalOpenFlags(readWrite));
    inspectSourceDescriptor(handle, identity, links);
    return handle;
  } catch (error) {
    if (handle) return await throwAfterClosing(error, [handle]);
    throw error;
  }
}

// Windows data-read access can synchronously inspect a completed file through
// filesystem filters. Prefer write-only admission, which still supports the
// descriptor metadata, chmod and sync operations used below. Providers or
// read-only files that reject that access retain the historical open contract.
async function openProducerSource(
  params: HandoffParents & { sourcePath: string; readWrite: boolean },
  identity: BigIntStats,
  links = 1n,
): Promise<FileHandle> {
  if (process.platform !== "win32") {
    return await openHistoricalSource(params.sourcePath, identity, params.readWrite, links);
  }

  let provisional: FileHandle | undefined;
  try {
    provisional = await fs.open(params.sourcePath, fsSync.constants.O_WRONLY);
  } catch (error) {
    if (!hasCode(error, ["EACCES", "EPERM", "EBUSY"])) throw error;
    return await openHistoricalSource(params.sourcePath, identity, params.readWrite, links);
  }

  try {
    inspectSourceDescriptor(provisional, identity, links);
    return provisional;
  } catch (error) {
    if (!hasCode(error, ["EACCES", "EPERM"])) {
      return await throwAfterClosing(error, [provisional]);
    }
  }

  let fallback: FileHandle | undefined;
  try {
    fallback = await fs.open(params.sourcePath, historicalOpenFlags(params.readWrite));
    inspectSourceDescriptor(fallback, identity, links);
    inspectLinkedFile(
      () => fsSync.lstatSync(params.sourcePath, { bigint: true }),
      identity,
      links,
      "isolated producer path",
    );
    assertParents(params);
  } catch (error) {
    return await throwAfterClosing(error, [fallback, provisional]);
  }

  try {
    await provisional.close();
  } catch (error) {
    return await throwAfterClosing(error, [fallback]);
  }
  return fallback;
}

function assertLinkedHandoff(
  params: HandoffParents & { sourcePath: string; targetPath: string },
  handle: FileHandle,
  identity: BigIntStats,
): void {
  assertParents(params);
  inspectSourceDescriptor(handle, identity, 2n);
  inspectLinkedFile(
    () => fsSync.lstatSync(params.sourcePath, { bigint: true }),
    identity,
    2n,
    "isolated producer path",
  );
  inspectLinkedFile(
    () => fsSync.lstatSync(params.targetPath, { bigint: true }),
    identity,
    2n,
    "isolated producer sibling",
  );
}

export async function handoffPrivateProducerFile(params: {
  sourcePath: string;
  targetPath: string;
  assertSourceParent: () => void;
  assertTargetParent: () => void;
  readWrite: boolean;
}): Promise<PrivateProducerHandoff> {
  assertParents(params);
  const identity = inspectFileIdentitySync(() => {
    const stat = fsSync.lstatSync(params.sourcePath, { bigint: true });
    assertInitialSource(stat);
    return stat;
  });

  let handle: FileHandle | undefined;
  let siblingHandle: FileHandle | undefined;
  let unregister: TempPathRegistration | undefined;
  const state: HandoffState = { siblingOwned: false };
  try {
    handle = await openProducerSource(params, identity);
    inspectLinkedFile(
      () => fsSync.lstatSync(params.sourcePath, { bigint: true }),
      identity,
      1n,
      "isolated producer path",
    );
    assertParents(params);

    unregister = registerTempPathForExit(params.targetPath, {
      cleanupSync: () => removeSiblingIfOwned({
        assertTargetParent: params.assertTargetParent,
        identity,
        state,
        targetPath: params.targetPath,
      }),
    });

    assertParents(params);
    try {
      fsSync.linkSync(params.sourcePath, params.targetPath);
    } catch (error) {
      throw normalizeLinkError(error);
    }
    state.siblingOwned = true;

    assertLinkedHandoff(params, handle, identity);
    if (process.platform === "win32") {
      // Legacy Windows unlink retains a delete-pending name until handles
      // opened through that name close. Transfer the pin before retiring it.
      siblingHandle = await openProducerSource({ ...params, sourcePath: params.targetPath }, identity, 2n);
      assertLinkedHandoff(params, siblingHandle, identity);
      inspectSourceDescriptor(handle, identity, 2n);
      await handle.close();
      handle = siblingHandle;
      siblingHandle = undefined;
      // The old handle's close yielded; both names must still be ours.
      assertLinkedHandoff(params, handle, identity);
    }

    assertParents(params);
    fsSync.unlinkSync(params.sourcePath);
    assertParents(params);
    const opened = inspectLinkedFile(
      () => fsSync.fstatSync(handle!.fd, { bigint: true }),
      identity,
      1n,
      "isolated producer descriptor",
    );
    const sibling = inspectLinkedFile(
      () => fsSync.lstatSync(params.targetPath, { bigint: true }),
      identity,
      1n,
      "isolated producer sibling",
    );
    const originalMode = identity.mode & 0o777n;
    if (process.platform === "win32" && (originalMode & 0o200n) === 0n &&
      ((opened.mode & 0o777n) !== originalMode || (sibling.mode & 0o777n) !== originalMode)) {
      // Legacy unlink clears the shared read-only attribute. Repair only the
      // admitted sibling inode, without reopening or chmodding its pathname.
      assertParents(params);
      fsSync.fchmodSync(handle.fd, Number(originalMode));
      assertParents(params);
      const restored = inspectLinkedFile(
        () => fsSync.fstatSync(handle!.fd, { bigint: true }),
        identity,
        1n,
        "isolated producer descriptor",
      );
      const restoredSibling = inspectLinkedFile(
        () => fsSync.lstatSync(params.targetPath, { bigint: true }),
        identity,
        1n,
        "isolated producer sibling",
      );
      if ((restored.mode & 0o777n) !== originalMode || (restoredSibling.mode & 0o777n) !== originalMode) {
        throw pathMismatch("isolated producer read-only mode could not be restored");
      }
    }

    const registered = unregister;
    const release = (() => {
      state.siblingOwned = false;
      registered();
    }) as TempPathRegistration;
    release.setIdentity = registered.setIdentity;
    return { handle, identity, unregister: release };
  } catch (error) {
    const settlement: unknown[] = [];
    if (unregister) {
      try {
        removeSiblingIfOwned({
          assertTargetParent: params.assertTargetParent,
          identity,
          state,
          targetPath: params.targetPath,
        });
        unregister();
      } catch (cleanupError) {
        settlement.push(cleanupError);
      }
    }
    for (const retained of new Set([siblingHandle, handle])) {
      if (!retained) continue;
      try {
        await retained.close();
      } catch (closeError) {
        settlement.push(closeError);
      }
    }
    throw combinedFailure(error, settlement);
  }
}
