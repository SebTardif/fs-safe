import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";
import { withPinnedWriteRenameIdentityLock } from "./pinned-write.js";
import { realpathSync } from "./realpath.js";
import { serializePathWrite } from "./write-queue.js";

function unsupportedSpelling(): FsSafeError {
  return new FsSafeError("path-alias", "Windows compatibility writes require lower-case ASCII destination components");
}

// The caller first applies the Root's ordinary path and mutation policies. This
// extra admission rule is deliberately narrower than general Windows filenames:
// the existing lock protocol has no portable case/Unicode equivalence key for a
// missing name. Do not guess one, or switch keys when a placeholder appears.
function effectiveDestination(rootPath: string, targetPath: string, rootIdentity?: RootBoundaryIdentity): string {
  let effective: string;
  try {
    effective = realpathSync.native(targetPath);
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
    let cursor = targetPath;
    const missing: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(cursor);
        break;
      } catch (error) {
        if (!isNotFoundPathError(error) || cursor === rootPath) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
    // An existing dangling link must fail resolution, not become a missing
    // lexical component. Keep the fallback bounded by the retained Root.
    effective = path.join(realpathSync.native(cursor), ...missing);
  }
  const admitted = admitPathInsideRoot({ rootPath, candidatePath: effective, rootIdentity });
  if (!admitted) throw unsupportedSpelling();
  const relative = admitted.relativePath;
  if (!relative || !relative.split(path.sep).every(component =>
    /^[a-z0-9._-]+$/.test(component) && !component.endsWith("."))) throw unsupportedSpelling();
  return admitted.path;
}

export function assertRootFallbackWritePath(expected: string | undefined, actual: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new FsSafeError("path-mismatch", "compatibility write destination changed after lock selection");
  }
}

export async function withRootFallbackCompatibilityLock<T>(
  params: { rootPath: string; targetPath: string; rootIdentity?: RootBoundaryIdentity; assertBeforeMutation?: () => void },
  run: (binding: { targetPath: string; relativePath: string; assertBeforeMutation: () => void }) => Promise<T>,
): Promise<T> {
  const targetPath = effectiveDestination(params.rootPath, params.targetPath, params.rootIdentity);
  const relativePath = path.relative(params.rootPath, targetPath).split(path.sep).join("/");
  const assertCurrent = () => assertRootFallbackWritePath(
    targetPath, effectiveDestination(params.rootPath, targetPath, params.rootIdentity),
  );
  // Sidecars are reentrant within one manager; aliases also need the same local
  // queue before acquisition. The outer Root queue uses the caller's spelling.
  return await serializePathWrite(targetPath, async () => await withPinnedWriteRenameIdentityLock({
    rootPath: params.rootPath, targetPath, relativeTargetPath: relativePath,
  }, async () => {
    // The guarded open resolves again under the lock; each mutation rechecks
    // below. Lock selection is never reused as post-lock filesystem authority.
    return await run({
      targetPath, relativePath,
      assertBeforeMutation: () => { params.assertBeforeMutation?.(); assertCurrent(); },
    });
  }));
}
