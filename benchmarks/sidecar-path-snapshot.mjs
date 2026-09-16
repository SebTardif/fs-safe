import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  attemptBenchmarkCleanup,
  throwBenchmarkFailures,
} from "./runner-cleanup.mjs";
import { applyBenchmarkPrivateWindowsAcl } from "./windows-private-directory.mjs";

const FIXTURE_DIRECTORY = "sidecar-path-snapshot";
const FALLBACK_PREFIX = ".fs-safe-sidecar-path-snapshot-";

const ROWS = [
  ["default/absolute", "absolute", "default", false],
  ["default/relative", "relative", "default", false],
  ["explicit/fully-qualified", "absolute", "absolute", false],
  ["explicit/relative", "relative", "relative", false],
  ["explicit/windows-current-drive-rooted", "absolute", "current-drive-rooted", false],
  ["explicit/windows-drive-relative", "absolute", "drive-relative", false],
  ["reentrant/default-absolute", "absolute", "default", true],
  ["reentrant/relative-explicit", "relative", "relative", true],
].map(([suffix, targetPathForm, lockPathForm, reentrant]) => Object.freeze({
  name: `SidecarPathSnapshot/${suffix}`,
  workloadSemantics: ["default", "absolute"].includes(lockPathForm)
    ? "equivalent-output" : "changed-output",
  workloadDetails: Object.freeze({
    targetPathForm,
    lockPathForm,
    reentrant,
    cwd: "stable; never changed by the fixture",
    timedOperation: "FileLockManager.acquire",
    untimedOperations: Object.freeze(["path construction", "fixture setup", "outer acquisition", "verification", "release", "cleanup"]),
    effectiveSidecar: "equivalent location and cleanup after resolving handle.lockPath against the stable cwd",
    handleLockPath: ["default", "absolute"].includes(lockPathForm)
      ? "absolute in both builds" : "requested spelling or absolute; spelling may differ between builds",
  }),
}));

export const SIDECAR_PATH_SNAPSHOT_NAMES = Object.freeze(ROWS.map(({ name }) => name));

function ordinaryWindowsDrive(filePath) {
  const root = path.win32.parse(filePath).root;
  return /^[A-Za-z]:[\\/]$/u.test(root) ? root.slice(0, 2).toLowerCase() : undefined;
}

export function selectSidecarPathSnapshotFixture({
  workspace,
  cwd,
  platform = process.platform,
}) {
  if (platform !== "win32") {
    return Object.freeze({
      allocation: "runner-workspace-child",
      classification: "runner-workspace",
      parent: workspace,
    });
  }
  const cwdDrive = ordinaryWindowsDrive(cwd);
  assert(cwdDrive, "Windows sidecar path benchmarks require an ordinary local-drive cwd");
  const workspaceDrive = ordinaryWindowsDrive(workspace);
  if (workspaceDrive === cwdDrive) {
    return Object.freeze({
      allocation: "runner-workspace-child",
      classification: "runner-workspace",
      parent: workspace,
    });
  }
  return Object.freeze({
    allocation: "unique-cwd-child",
    classification: "cwd-same-drive-fallback",
    parent: cwd,
  });
}

export function validateSidecarPathSnapshotWorkloadResult(result) {
  if (!result.name.startsWith("SidecarPathSnapshot/")) return;
  const row = ROWS.find(({ name }) => name === result.name);
  assert(row, `Unknown sidecar path snapshot row: ${result.name}`);
  assert.equal(result.workloadSemantics, row.workloadSemantics,
    `sidecar path snapshot workload semantics mismatch for ${result.name}`);
  assert.deepEqual(result.workloadDetails, row.workloadDetails,
    `sidecar path snapshot workload details mismatch for ${result.name}`);
  assert.deepEqual(Object.keys(result.fixturePlacement ?? {}).sort(), ["classification", "sameDrive"],
    `sidecar path snapshot fixture receipt is incomplete for ${result.name}`);
  assert(["runner-workspace", "cwd-same-drive-fallback"].includes(result.fixturePlacement.classification),
    `sidecar path snapshot fixture classification is invalid for ${result.name}`);
  assert([true, false, null].includes(result.fixturePlacement.sameDrive),
    `sidecar path snapshot same-drive receipt is invalid for ${result.name}`);
}

export function validateSidecarPathSnapshotReport(report, filter = "", expectedIterations) {
  const expectedNames = SIDECAR_PATH_SNAPSHOT_NAMES.filter((name) => !filter || name.includes(filter));
  const results = (report.results ?? [])
    .filter(({ name }) => name.startsWith("SidecarPathSnapshot/"));
  assert.deepEqual(results.map(({ name }) => name), expectedNames,
    "sidecar path snapshot report row set mismatch");
  if (results.length === 0) return;

  const platform = report.metadata?.platform;
  assert(["linux", "darwin", "win32"].includes(platform),
    "sidecar path snapshot report platform is unsupported");
  for (const result of results) validateSidecarPathSnapshotWorkloadResult(result);
  const placement = results[0].fixturePlacement;
  for (const result of results) {
    assert.deepEqual(result.fixturePlacement, placement,
      "sidecar path snapshot fixture placement changed within one report");
  }
  if (platform === "win32") {
    assert.equal(placement.sameDrive, true,
      "Windows sidecar path snapshot fixture was not verified on the cwd drive");
  } else {
    assert.deepEqual(placement, { classification: "runner-workspace", sameDrive: null },
      "portable sidecar path snapshot fixture receipt is invalid");
  }
  for (const result of results) {
    const row = ROWS.find(({ name }) => name === result.name);
    assert(row);
    const windowsOnly = ["current-drive-rooted", "drive-relative"]
      .includes(row.workloadDetails.lockPathForm);
    if (platform === "win32") {
      assert.equal(result.skipped, undefined,
        `Windows sidecar path snapshot row was not measured: ${result.name}`);
    } else if (windowsOnly) {
      assert.equal(result.skipped, "This path form requires Windows.",
        `portable sidecar path snapshot skip mismatch: ${result.name}`);
    } else {
      assert.equal(result.skipped, undefined,
        `portable sidecar path snapshot row was not measured: ${result.name}`);
    }
    if (result.skipped === undefined && expectedIterations !== undefined) {
      assert.equal(result.iterations, expectedIterations,
        `sidecar path snapshot iteration count mismatch: ${result.name}`);
    }
  }
}

// Pure planning also makes Windows skip rules testable on every host.
export function sidecarPathSnapshotCases({
  workspace,
  cwd,
  platform = process.platform,
  fixtureClassification = "runner-workspace",
}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const localDrive = /^[a-z]:[\\/]/iu;
  const sameLocalDrive = localDrive.test(workspace) && localDrive.test(cwd) &&
    workspace.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase();
  const fixturePlacement = Object.freeze({
    classification: fixtureClassification,
    sameDrive: platform === "win32" ? sameLocalDrive : null,
  });
  return ROWS.map((row, index) => {
    const { targetPathForm, lockPathForm } = row.workloadDetails;
    const windowsOnly = ["current-drive-rooted", "drive-relative"].includes(lockPathForm);
    const needsRelative = targetPathForm === "relative" || windowsOnly;
    const skip = windowsOnly && platform !== "win32"
      ? "This path form requires Windows."
      : platform === "win32" && needsRelative && !sameLocalDrive
        ? "Relative Windows paths require workspace and cwd on the same ordinary local drive."
        : undefined;
    const directory = paths.join(workspace, `row-${index}`);
    const expectedTargetPath = paths.join(directory, "target");
    const expectedLockPath = lockPathForm === "default"
      ? `${expectedTargetPath}.lock` : paths.join(directory, "explicit.lock");
    const targetPath = targetPathForm === "relative"
      ? paths.relative(cwd, expectedTargetPath) : expectedTargetPath;
    const lockPath = lockPathForm === "default" ? undefined
      : lockPathForm === "absolute" ? expectedLockPath
      : lockPathForm === "current-drive-rooted" ? expectedLockPath.slice(2)
      : lockPathForm === "drive-relative" ? `${cwd.slice(0, 2)}${paths.relative(cwd, expectedLockPath)}`
      : paths.relative(cwd, expectedLockPath);
    return {
      ...row,
      directory,
      expectedTargetPath,
      expectedLockPath,
      targetPath,
      lockPath,
      skip,
      fixturePlacement,
    };
  });
}

export function preflightSidecarPathSnapshotCase(
  row,
  { resolvePath = path.resolve, paths = process.platform === "win32" ? path.win32 : path.posix } = {},
) {
  if (row.skip) return row.skip;
  const resolvedTargetPath = resolvePath(row.targetPath);
  assert.equal(paths.relative(row.expectedTargetPath, resolvedTargetPath), "",
    `${row.name} target path does not resolve to its fixture`);
  if (row.lockPath === undefined) return undefined;

  let resolvedLockPath;
  try {
    resolvedLockPath = resolvePath(row.lockPath);
  } catch (error) {
    if (row.workloadDetails.lockPathForm === "drive-relative") {
      return `The inherited drive working directory cannot resolve ${row.lockPath}: ${error}`;
    }
    throw error;
  }
  const lockDifference = paths.relative(row.expectedLockPath, resolvedLockPath);
  if (row.workloadDetails.lockPathForm === "drive-relative" && lockDifference !== "") {
    return "The inherited drive working directory differs from process.cwd().";
  }
  assert.equal(lockDifference, "", `${row.name} lock path does not resolve to its fixture`);
  return undefined;
}

export function registerSidecarPathSnapshot({
  api,
  workspace,
  register,
  onCleanup,
  platform = process.platform,
  cwd = process.cwd(),
  allocateFallback = (prefix) => fs.mkdtempSync(prefix),
  canonicalizeFixture = (directory) => fs.realpathSync.native(directory),
  preparePrivateDirectory = (directory) => applyBenchmarkPrivateWindowsAcl(api, directory, { platform }),
}) {
  const selection = selectSidecarPathSnapshotFixture({ workspace, cwd, platform });
  let fixture;
  let fixtureCreated = false;
  let manager;
  const createdRows = [];
  const assertStableCwd = () => assert.equal(process.cwd(), cwd, "sidecar benchmark cwd changed");
  const assertRemoved = (row) => {
    assert.deepEqual(manager.heldEntries(), [], "sidecar benchmark manager retained a lock");
    assert.deepEqual(fs.readdirSync(row.directory), [], "sidecar benchmark left a lock or reclaim file");
  };
  onCleanup(async () => {
    const failures = [];
    if (manager) {
      await attemptBenchmarkCleanup(failures, () => manager.drain());
      let retainedEntries = [];
      try {
        retainedEntries = [...manager.heldEntries()];
        assert.deepEqual(retainedEntries, [], "sidecar benchmark drain retained a lock");
      } catch (error) {
        failures.push(error);
      }
      for (const entry of retainedEntries) {
        await attemptBenchmarkCleanup(failures, () => entry.forceRelease());
      }
    }
    for (const row of createdRows) {
      await attemptBenchmarkCleanup(failures, () => {
        assert.deepEqual(fs.readdirSync(row.directory), [],
          "sidecar benchmark left a lock or reclaim file");
      });
      await attemptBenchmarkCleanup(failures, () => {
        fs.rmSync(row.directory, { recursive: true, force: true });
      });
    }
    if (fixtureCreated && fixture) {
      await attemptBenchmarkCleanup(failures, () => {
        fs.rmSync(fixture, { recursive: true, force: true });
      });
    }
    throwBenchmarkFailures(failures, "sidecar benchmark cleanup failed");
  });

  if (selection.allocation === "runner-workspace-child") {
    fixture = path.join(selection.parent, FIXTURE_DIRECTORY);
    fs.mkdirSync(fixture);
  } else {
    fixture = allocateFallback(path.join(selection.parent, FALLBACK_PREFIX));
  }
  fixtureCreated = true;
  preparePrivateDirectory(fixture);
  const canonicalFixture = canonicalizeFixture(fixture);
  const rows = sidecarPathSnapshotCases({
    workspace: canonicalFixture,
    cwd,
    platform,
    fixtureClassification: selection.classification,
  })
    .map((row) => ({
      ...row,
      skip: preflightSidecarPathSnapshotCase(row),
    }));
  if (platform === "win32") {
    for (const row of rows) {
      assert.equal(row.skip, undefined, `Windows sidecar fixture preflight failed: ${row.name}`);
    }
  }
  manager = api.createFileLockManager(`fs-safe-benchmark:sidecar-path-snapshot:${canonicalFixture}`);
  const payload = { pid: process.pid, createdAt: new Date().toISOString() };
  for (const row of rows) {
    const { targetPath, lockPath, expectedTargetPath, expectedLockPath } = row;
    const options = {
      payload: () => payload,
      timeoutMs: 1000,
      ...(lockPath === undefined ? {} : { lockPath }),
      ...(row.workloadDetails.reentrant ? { reentrantOwner: row.name } : {}),
    };
    if (!row.skip) {
      fs.mkdirSync(row.directory);
      createdRows.push(row);
    }
    register(row.name, () => manager.acquire(targetPath, options), {
      covers: ["FileLockManager.acquire"],
      skip: row.skip,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      fixturePlacement: row.fixturePlacement,
      before: async () => {
        assertStableCwd();
        assert.equal(preflightSidecarPathSnapshotCase(row), undefined,
          `${row.name} implicit path resolution changed`);
        assertRemoved(row);
        return row.workloadDetails.reentrant ? await manager.acquire(targetPath, options) : undefined;
      },
      after: async (handle, outer) => {
        const failures = [];
        await attemptBenchmarkCleanup(failures, async () => {
          assertStableCwd();
          assert(handle, "sidecar benchmark returned no handle");
          // Baseline builds can return the explicit relative spelling.
          assert.equal(path.relative(expectedLockPath, path.resolve(handle.lockPath)), "");
          if (["default", "absolute"].includes(row.workloadDetails.lockPathForm)) {
            assert.equal(path.isAbsolute(handle.lockPath), true,
              "sidecar benchmark expected an absolute returned lock path");
          }
          assert.equal(path.isAbsolute(handle.normalizedTargetPath), true,
            "sidecar benchmark expected an absolute normalized target path");
          assert.equal(path.relative(expectedTargetPath, handle.normalizedTargetPath), "");
          assert.equal(await handle.verifyStillHeld(), true);
        });
        if (handle) await attemptBenchmarkCleanup(failures, () => handle.release());
        if (outer) {
          await attemptBenchmarkCleanup(failures, async () => {
            assert.equal(await outer.verifyStillHeld(), true, "inner release removed the outer lock");
            assert.equal(fs.statSync(expectedLockPath).isFile(), true);
          });
          await attemptBenchmarkCleanup(failures, () => outer.release());
        }
        await attemptBenchmarkCleanup(failures, () => assertRemoved(row));
        throwBenchmarkFailures(failures, `${row.name} verification or cleanup failed`);
      },
    });
  }
}
