import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { createFileLockManager } from "@openclaw/fs-safe/file-lock";
import { root } from "@openclaw/fs-safe/root";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

const mode = process.argv[2];
assert.ok(mode === "off" || mode === "require");
configureFsSafeNative({ mode });

const require = createRequire(import.meta.url);
const consumer = fsSync.realpathSync.native(process.cwd());
const expected = JSON.parse(await fs.readFile(path.join(consumer, "expected.json"), "utf8"));
const originalCwd = process.cwd();
const sandbox = await fs.realpath(await fs.mkdtemp(path.join(consumer, "sidecar-snapshot-proof-")));
const rows = [];
let receipt;
const moduleNames = [
  "config.js",
  "file-lock.js",
  "native-config.js",
  "root.js",
  "root-impl.js",
  "sidecar-lock.js",
  "sidecar-lock-acquire.js",
  "sidecar-lock-handle.js",
  "sidecar-lock-reclaim.js",
];

function hash(file) {
  return createHash("sha256").update(fsSync.readFileSync(file)).digest("hex");
}

function throwCombined(primary, cleanup, message) {
  if (primary && cleanup.length) throw new AggregateError([primary, ...cleanup], message);
  if (primary) throw primary;
  if (cleanup.length === 1) throw cleanup[0];
  if (cleanup.length) throw new AggregateError(cleanup, message);
}

function assertInsideConsumer(file) {
  const relative = path.relative(consumer, fsSync.realpathSync.native(file));
  assert.ok(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `package path escaped the consumer: ${file}`,
  );
}

async function createRowDirectories(label) {
  const directory = path.join(sandbox, label);
  const before = path.join(directory, "before");
  const after = path.join(directory, "after");
  await Promise.all([
    fs.mkdir(path.join(before, "locks"), { recursive: true }),
    fs.mkdir(path.join(after, "locks"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(after, "sentinel"), "after-root-unchanged"),
    fs.writeFile(path.join(after, "locks", "sentinel"), "after-locks-unchanged"),
  ]);
  return {
    before: fsSync.realpathSync.native(before),
    after: fsSync.realpathSync.native(after),
  };
}

async function assertAfterTreeUnchanged(after) {
  assert.deepEqual((await fs.readdir(after)).sort(), ["locks", "sentinel"]);
  assert.deepEqual(await fs.readdir(path.join(after, "locks")), ["sentinel"]);
  assert.equal(await fs.readFile(path.join(after, "sentinel"), "utf8"), "after-root-unchanged");
  assert.equal(
    await fs.readFile(path.join(after, "locks", "sentinel"), "utf8"),
    "after-locks-unchanged",
  );
}

async function runRow(row) {
  const manager = createFileLockManager(`consumer-sidecar:${mode}:${row.label}:${sandbox}`);
  const cleanup = [];
  let handle;
  let pending;
  let primary;
  try {
    await assertAfterTreeUnchanged(row.after);
    const options = row.options();
    process.chdir(row.before);
    pending = manager.acquire(row.targetPath, options);
    process.chdir(row.after);
    row.afterStart?.();

    handle = await pending;
    assert.equal(handle.normalizedTargetPath, row.expectedTargetPath);
    assert.equal(handle.lockPath, row.expectedReturnedLockPath);
    assert.equal(await handle.verifyStillHeld(), true);
    assert.equal((await fs.stat(row.expectedFilePath)).isFile(), true);
    assert.equal(manager.heldEntries().length, 1);
    await assertAfterTreeUnchanged(row.after);
    await row.assertDuring?.();

    await handle.release();
    await assert.rejects(fs.stat(row.expectedFilePath), { code: "ENOENT" });
    assert.deepEqual(manager.heldEntries(), []);
    await assertAfterTreeUnchanged(row.after);
    await row.assertAfter?.();
    rows.push({
      label: row.label,
      targetPath: row.targetPath,
      lockPath: row.lockPath,
      normalizedTargetPath: handle.normalizedTargetPath,
      returnedLockPath: handle.lockPath,
      expectedFilePath: row.expectedFilePath,
      verified: true,
      released: true,
    });
  } catch (error) {
    primary = error;
  }

  if (pending && !handle) {
    try { handle = await pending; }
    catch (error) {
      if (error !== primary) cleanup.push(error);
    }
  }
  if (handle) {
    try { await handle.release(); }
    catch (error) { cleanup.push(error); }
  }
  for (const entry of manager.heldEntries()) {
    try { await entry.forceRelease(); }
    catch (error) { cleanup.push(error); }
  }
  try { await manager.drain(); }
  catch (error) { cleanup.push(error); }
  try { assert.deepEqual(manager.heldEntries(), []); }
  catch (error) { cleanup.push(error); }
  try { process.chdir(originalCwd); }
  catch (error) { cleanup.push(error); }
  throwCombined(primary, cleanup, `sidecar consumer row ${row.label} and cleanup both failed`);
}

async function commonRow(label, configure) {
  const directories = await createRowDirectories(label);
  const targetPath = "state.json";
  const expectedTargetPath = path.join(directories.before, targetPath);
  return configure({ ...directories, label, targetPath, expectedTargetPath });
}

let failure;
try {
  await runRow(await commonRow("relative-default", (row) => ({
    ...row,
    expectedReturnedLockPath: `${row.expectedTargetPath}.lock`,
    expectedFilePath: `${row.expectedTargetPath}.lock`,
    options: () => ({
      staleMs: 30_000,
      retry: { retries: 0 },
      payload: () => ({ owner: row.label }),
    }),
  })));

  await runRow(await commonRow("relative-explicit", (row) => {
    const lockPath = path.join("locks", "state.lock");
    const expectedLockPath = path.join(row.before, lockPath);
    return {
      ...row,
      lockPath,
      expectedReturnedLockPath: expectedLockPath,
      expectedFilePath: expectedLockPath,
      options: () => ({
        lockPath,
        staleMs: 30_000,
        retry: { retries: 0 },
        payload: () => ({ owner: row.label }),
      }),
    };
  }));

  await runRow(await commonRow("absolute-spelling", (row) => {
    const lockPath = `${path.join(row.before, "locks")}${path.sep}${path.sep}state.lock`;
    return {
      ...row,
      lockPath,
      expectedReturnedLockPath: lockPath,
      expectedFilePath: lockPath,
      options: () => ({
        lockPath,
        staleMs: 30_000,
        retry: { retries: 0 },
        payload: () => ({ owner: row.label }),
      }),
    };
  }));

  {
    const row = await commonRow("root-capability", (value) => value);
    const firstDirectory = path.join(sandbox, row.label, "first-root");
    const secondDirectory = path.join(sandbox, row.label, "second-root");
    await Promise.all([
      fs.mkdir(firstDirectory, { recursive: true }),
      fs.mkdir(secondDirectory, { recursive: true }),
    ]);
    const firstRoot = await root(firstDirectory);
    const secondRoot = await root(secondDirectory);
    const lockPath = path.join(firstRoot.rootReal, "nested", "state.lock");
    let selectedRoot = firstRoot;
    let lockRootReads = 0;
    await runRow({
      ...row,
      lockPath,
      expectedReturnedLockPath: lockPath,
      expectedFilePath: lockPath,
      options: () => ({
        lockPath,
        staleMs: 30_000,
        retry: { retries: 0 },
        payload: () => ({ owner: row.label }),
        get lockRoot() {
          lockRootReads += 1;
          return selectedRoot;
        },
      }),
      afterStart: () => {
        assert.equal(lockRootReads, 1);
        selectedRoot = secondRoot;
      },
      assertDuring: async () => {
        assert.equal(lockRootReads, 1);
        assert.deepEqual(await fs.readdir(secondRoot.rootReal), []);
      },
      assertAfter: async () => {
        assert.equal(lockRootReads, 1);
        assert.deepEqual(await fs.readdir(secondRoot.rootReal), []);
      },
    });
  }

  if (process.platform === "win32") {
    await runRow(await commonRow("current-drive-rooted", (row) => {
      const absoluteLockPath = path.join(row.before, "locks", "rooted.lock");
      const driveRoot = path.parse(absoluteLockPath).root;
      assert.match(driveRoot, /^[A-Za-z]:[\\/]$/u);
      const lockPath = absoluteLockPath.slice(driveRoot.length - 1);
      process.chdir(row.before);
      const expectedLockPath = path.resolve(lockPath);
      process.chdir(originalCwd);
      assert.equal(expectedLockPath, absoluteLockPath);
      return {
        ...row,
        lockPath,
        expectedReturnedLockPath: expectedLockPath,
        expectedFilePath: expectedLockPath,
        options: () => ({
          lockPath,
          staleMs: 30_000,
          retry: { retries: 0 },
          payload: () => ({ owner: row.label }),
        }),
      };
    }));

    await runRow(await commonRow("drive-relative", (row) => {
      const absoluteLockPath = path.join(row.before, "locks", "drive-relative.lock");
      const driveRoot = path.parse(absoluteLockPath).root;
      assert.match(driveRoot, /^[A-Za-z]:[\\/]$/u);
      const lockPath = `${driveRoot.slice(0, 2)}locks${path.sep}drive-relative.lock`;
      process.chdir(row.before);
      const expectedLockPath = path.resolve(lockPath);
      process.chdir(originalCwd);
      assert.equal(expectedLockPath, absoluteLockPath);
      return {
        ...row,
        lockPath,
        expectedReturnedLockPath: expectedLockPath,
        expectedFilePath: expectedLockPath,
        options: () => ({
          lockPath,
          staleMs: 30_000,
          retry: { retries: 0 },
          payload: () => ({ owner: row.label }),
        }),
      };
    }));
  }

  assert.equal(rows.length, process.platform === "win32" ? 6 : 4);

  const rootManifest = require.resolve("@openclaw/fs-safe/package.json");
  assertInsideConsumer(rootManifest);
  const packageDirectory = path.dirname(rootManifest);
  const rootRequire = createRequire(rootManifest);
  const expectedModuleNames = Object.keys(expected.sidecarModuleHashes).sort();
  assert.deepEqual(expectedModuleNames, [...moduleNames].sort());
  const compiledModules = {};
  for (const name of moduleNames) {
    const file = path.join(packageDirectory, "dist", name);
    assertInsideConsumer(file);
    const digest = hash(file);
    assert.equal(digest, expected.sidecarModuleHashes[name]);
    compiledModules[path.relative(consumer, file)] = digest;
  }
  assert.equal(
    fsSync.realpathSync.native(require.resolve("@openclaw/fs-safe/file-lock")),
    fsSync.realpathSync.native(path.join(packageDirectory, "dist", "file-lock.js")),
  );
  assert.equal(
    fsSync.realpathSync.native(require.resolve("@openclaw/fs-safe/root")),
    fsSync.realpathSync.native(path.join(packageDirectory, "dist", "root.js")),
  );
  assert.equal(
    fsSync.realpathSync.native(require.resolve("@openclaw/fs-safe/config")),
    fsSync.realpathSync.native(path.join(packageDirectory, "dist", "config.js")),
  );

  const probeHash = hash(new URL(import.meta.url));
  const metadataHelperHash = hash(new URL("./consumer-proof-metadata.mjs", import.meta.url));
  assert.equal(probeHash, expected.sidecarProbeHash);
  assert.equal(metadataHelperHash, expected.metadataHelperHash);
  const binary = fsSync.realpathSync.native(rootRequire.resolve(expected.host.package));
  assertInsideConsumer(binary);
  const loaded = nativeBinaryLoaded(binary);
  assert.equal(loaded, mode === "require");

  receipt = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    mode,
    compiledModules,
    probeSha256: probeHash,
    metadataHelperSha256: metadataHelperHash,
    binary: path.relative(consumer, binary),
    binarySha256: hash(binary),
    nativeLoaded: loaded,
    rows,
  };
} catch (error) {
  failure = error;
}

const cleanup = [];
try { process.chdir(originalCwd); }
catch (error) { cleanup.push(error); }
try { await fs.rm(sandbox, { recursive: true }); }
catch (error) { cleanup.push(error); }
throwCombined(failure, cleanup, "sidecar consumer proof and cleanup both failed");
console.log(JSON.stringify(receipt));
