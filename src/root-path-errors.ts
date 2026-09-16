import { formatErrorDetail, shortPath } from "./error-detail.js";

export function sanitizeRootPathError(error: unknown): unknown {
  if (error instanceof Error) {
    error.message = formatErrorDetail(error.message);
  }
  return error;
}

export function pathEscapeError(params: {
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): Error {
  return new Error(
    `Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`,
  );
}

export function symlinkEscapeError(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  symlinkPath: string;
}): Error {
  return new Error(
    `Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`,
  );
}
