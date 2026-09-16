import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { probePathSuffixAliasesSync } from "@openclaw/fs-safe/advanced";
import { sha256File } from "@openclaw/fs-safe/durability";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

const mode = process.argv[2];
assert.ok(mode === "off" || mode === "require");
const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
assert.ok(expected.manager?.name === "npm" || expected.manager?.name === "pnpm");
configureFsSafeNative({ mode });

const require = createRequire(import.meta.url);
const rootManifest = fs.realpathSync.native(require.resolve("@openclaw/fs-safe/package.json"));
const rootDirectory = path.dirname(rootManifest);
const rootRequire = createRequire(rootManifest);
const consumer = fs.realpathSync.native(process.cwd());
const rows = [];
const compiledModuleNames = [
  "advanced.js",
  "byte-budget.js",
  "config.js",
  "device-path.js",
  "directory-guard.js",
  "durability.js",
  "errors.js",
  "file-hash.js",
  "file-identity.js",
  "file-observation.js",
  "local-file-access.js",
  "native-config.js",
  "native.js",
  "path-suffix-aliases.js",
  "path.js",
  "read-open-flags.js",
  "realpath.js",
  "root-errors.js",
  "safe-path-segment.js",
  "strict-file-identity.js",
  "string-coerce.js",
];

function hash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), directory: stat.isDirectory() };
}

function inventory(directory) {
  return fs.readdirSync(directory).toSorted();
}

function empty(directory) {
  assert.deepEqual(inventory(directory), []);
  return true;
}

function observeOnlyOwnedDirectory(directory) {
  const names = inventory(directory);
  assert.equal(names.length, 1);
  const stat = fs.lstatSync(path.join(directory, names[0]), { bigint: true });
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  return { dev: String(stat.dev), ino: String(stat.ino), directory: true };
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function errorName(operation) {
  try {
    operation();
  } catch (error) {
    return error?.name;
  }
  assert.fail("expected operation to throw");
}

function directObservation(directory, left, right) {
  const first = path.join(directory, left);
  fs.mkdirSync(first, { recursive: true });
  try {
    const original = fs.lstatSync(first, { bigint: true });
    try {
      const alternate = fs.lstatSync(path.join(directory, right), { bigint: true });
      return original.dev === alternate.dev && original.ino === alternate.ino;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  } finally {
    fs.rmSync(path.join(directory, left.split(path.sep)[0]), { recursive: true, force: true });
  }
}

const expectedCompiledNames = Object.keys(expected.suffixCompiledSha256).toSorted();
assert.deepEqual(expectedCompiledNames, compiledModuleNames.toSorted());
const compiledModules = Object.fromEntries(compiledModuleNames.map((name) => [
  name,
  hash(path.join(rootDirectory, "dist", name)),
]));
assert.deepEqual(compiledModules, expected.suffixCompiledSha256);
const probeSha256 = hash(new URL(import.meta.url));
const metadataHelperSha256 = hash(new URL("./consumer-proof-metadata.mjs", import.meta.url));
assert.equal(probeSha256, expected.suffixProbeSha256);
assert.equal(metadataHelperSha256, expected.metadataHelperSha256);

const advancedModule = fs.realpathSync.native(require.resolve("@openclaw/fs-safe/advanced"));
assert.equal(advancedModule, fs.realpathSync.native(path.join(rootDirectory, "dist", "advanced.js")));
const binary = fs.realpathSync.native(rootRequire.resolve(expected.host.package));
assert.equal(hash(binary), expected.hostBinarySha256);
const nativeLoadedBeforePrime = nativeBinaryLoaded(binary);
assert.equal(nativeLoadedBeforePrime, false);

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(process.cwd(), "suffix-proof-")));
const rootBefore = identity(sandbox);
let nativeLoadedAfterPrime;
try {
  const prime = path.join(sandbox, "prime.txt");
  fs.writeFileSync(prime, "suffix proof native prime");
  if (mode === "require") {
    const observed = await sha256File(prime);
    assert.equal(observed.digest, hash(prime));
    assert.equal(observed.bytes, fs.statSync(prime).size);
  }
  nativeLoadedAfterPrime = nativeBinaryLoaded(binary);
  assert.equal(nativeLoadedAfterPrime, mode === "require");
  fs.unlinkSync(prime);

  {
    const missing = path.join(sandbox, "identical-directory-does-not-exist");
    const result = probePathSuffixAliasesSync({ directory: missing, left: "same", right: "same" });
    assert.equal(result, true);
    assert.equal(fs.existsSync(missing), false);
    rows.push({ scenario: "identical-no-predicate", result, predicate: "omitted", directoryRemainedAbsent: true });
  }

  for (const [scenario, left, right] of [
    ["lookup-ascii", "Worker.sqlite", "worker.sqlite"],
    ["lookup-raw-nfc-nfd", "caf\u00e9.sqlite", "cafe\u0301.sqlite"],
    ["lookup-non-ascii-case", "\u00c9.sqlite", "\u00e9.sqlite"],
    ["lookup-nested", path.join("same", "same", "Worker.sqlite"), path.join("same", "same", "worker.sqlite")],
  ]) {
    const directory = path.join(sandbox, scenario);
    fs.mkdirSync(directory);
    const expectedResult = directObservation(directory, left, right);
    assert.equal(empty(directory), true);
    const originalMkdir = fs.mkdirSync;
    const mutations = [];
    if (scenario === "lookup-nested") {
      fs.mkdirSync = (candidate, ...args) => {
        mutations.push(String(candidate));
        return originalMkdir(candidate, ...args);
      };
    }
    let result;
    try {
      result = probePathSuffixAliasesSync({ directory, left, right });
    } finally {
      fs.mkdirSync = originalMkdir;
    }
    assert.equal(result, expectedResult);
    const maxMutationDepth = mutations.length === 0 ? null : Math.max(...mutations.map((candidate) => {
      assert.equal(inside(directory, candidate), true);
      return path.relative(directory, candidate).split(path.sep).length;
    }));
    if (scenario === "lookup-nested") assert.equal(maxMutationDepth, 3);
    rows.push({ scenario, result, directLookupResult: expectedResult, maxMutationDepth, cleanupComplete: empty(directory) });
    fs.rmdirSync(directory);
  }

  {
    const directory = path.join(sandbox, "policy-exclusion");
    fs.mkdirSync(directory);
    const calls = [];
    let ownedDirectory;
    const result = probePathSuffixAliasesSync({
      directory,
      left: path.join("same", "\u0130.sqlite"),
      right: path.join("same", "i\u0307.sqlite"),
      shouldProbeCaseVariants: (...pair) => {
        ownedDirectory = observeOnlyOwnedDirectory(directory);
        calls.push(pair);
        return false;
      },
    });
    assert.equal(result, false);
    assert.ok(ownedDirectory);
    assert.deepEqual(calls, [["\u0130.sqlite", "i\u0307.sqlite"]]);
    rows.push({
      scenario: "policy-exclusion-after-creation",
      result,
      callbackCalls: calls.length,
      ownedDirectoryObservedBeforeCallback: ownedDirectory,
      cleanupComplete: empty(directory),
    });
    fs.rmdirSync(directory);
  }

  {
    const directory = path.join(sandbox, "thrown-sentinel");
    fs.mkdirSync(directory);
    const sentinel = Object.freeze({ proof: "exact thrown sentinel" });
    let caught;
    let ownedDirectory;
    try {
      probePathSuffixAliasesSync({
        directory,
        left: path.join("same", "\u0130.sqlite"),
        right: path.join("same", "i\u0307.sqlite"),
        shouldProbeCaseVariants: () => {
          ownedDirectory = observeOnlyOwnedDirectory(directory);
          throw sentinel;
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, sentinel);
    assert.ok(ownedDirectory);
    rows.push({
      scenario: "exact-thrown-sentinel",
      exactIdentityRethrown: true,
      ownedDirectoryObservedBeforeCallback: ownedDirectory,
      cleanupComplete: empty(directory),
    });
    fs.rmdirSync(directory);
  }

  {
    const directory = path.join(sandbox, "relative-anchor");
    const other = path.join(sandbox, "relative-other");
    fs.mkdirSync(directory);
    fs.mkdirSync(other);
    const expectedResult = directObservation(directory, "ABC", "abc");
    const previousCwd = process.cwd();
    const originalMkdir = fs.mkdirSync;
    const mutations = [];
    fs.mkdirSync = (candidate, ...args) => {
      mutations.push(String(candidate));
      return originalMkdir(candidate, ...args);
    };
    let result;
    try {
      process.chdir(directory);
      result = probePathSuffixAliasesSync({
        get directory() { return "."; },
        get left() { process.chdir(other); return "ABC"; },
        right: "abc",
      });
    } finally {
      process.chdir(previousCwd);
      fs.mkdirSync = originalMkdir;
    }
    assert.equal(result, expectedResult);
    assert.ok(mutations.length > 0);
    assert.ok(mutations.every((candidate) => path.isAbsolute(candidate) && inside(directory, candidate)));
    rows.push({
      scenario: "relative-directory-anchored-before-getter-chdir",
      result,
      directLookupResult: expectedResult,
      mutationCount: mutations.length,
      cleanupComplete: empty(directory) && empty(other),
    });
    fs.rmdirSync(directory);
    fs.rmdirSync(other);
  }

  {
    const directory = path.join(sandbox, "invalid-limits");
    fs.mkdirSync(directory);
    const before = inventory(directory);
    const originalMkdir = fs.mkdirSync;
    let mutations = 0;
    fs.mkdirSync = (...args) => { mutations++; return originalMkdir(...args); };
    let invalid;
    let overLimit;
    try {
      invalid = errorName(() => probePathSuffixAliasesSync({ directory, left: "..", right: ".." }));
      const suffix = "a".repeat(8_193);
      overLimit = errorName(() => probePathSuffixAliasesSync({ directory, left: suffix, right: suffix }));
    } finally {
      fs.mkdirSync = originalMkdir;
    }
    assert.equal(invalid, "TypeError");
    assert.equal(overLimit, "RangeError");
    assert.equal(mutations, 0);
    assert.deepEqual(inventory(directory), before);
    rows.push({ scenario: "invalid-and-over-limit-no-mutation", invalid, overLimit, mutationCount: mutations, cleanupComplete: true });
    fs.rmdirSync(directory);
  }

  {
    const directory = path.join(sandbox, "collision-exhaustion");
    fs.mkdirSync(directory);
    for (const name of "bdefghijkmoqrstuvwxyz") {
      const occupied = path.join(directory, name);
      fs.mkdirSync(occupied);
      fs.writeFileSync(path.join(occupied, "sentinel"), name);
    }
    const before = inventory(directory);
    const result = probePathSuffixAliasesSync({ directory, left: "A", right: "a" });
    assert.equal(result, undefined);
    assert.deepEqual(inventory(directory), before);
    for (const name of before) assert.equal(fs.readFileSync(path.join(directory, name, "sentinel"), "utf8"), name);
    rows.push({
      scenario: "deterministic-collision-exhaustion",
      result: "undefined",
      occupiedCandidates: before.length,
      sentinelsPreserved: true,
      libraryCleanup: "no-owned-entry-created",
    });
    fs.rmSync(directory, { recursive: true });
  }

  {
    const directory = path.join(sandbox, "ancestor-replacement");
    fs.mkdirSync(directory);
    const originalMkdir = fs.mkdirSync;
    const forwardMutationsAfterReplacement = [];
    let witness;
    let result;
    try {
      result = probePathSuffixAliasesSync({
        directory,
        left: path.join("same", "\u00c9"),
        right: path.join("same", "\u00e9"),
        shouldProbeCaseVariants: () => {
          const [ownedName] = inventory(directory);
          assert.ok(ownedName);
          const owned = path.join(directory, ownedName);
          const moved = path.join(directory, "admitted-original");
          const before = identity(owned);
          fs.renameSync(owned, moved);
          originalMkdir(owned);
          fs.writeFileSync(path.join(moved, "sentinel"), "original");
          witness = { before, moved: identity(moved), replacement: identity(owned), owned, movedPath: moved };
          fs.mkdirSync = (candidate, ...args) => {
            forwardMutationsAfterReplacement.push(String(candidate));
            return originalMkdir(candidate, ...args);
          };
          return true;
        },
      });
    } finally {
      fs.mkdirSync = originalMkdir;
    }
    assert.equal(result, undefined);
    assert.ok(witness);
    assert.deepEqual(witness.moved, witness.before);
    assert.notDeepEqual(witness.replacement, witness.before);
    assert.deepEqual(identity(witness.owned), witness.replacement);
    assert.deepEqual(inventory(witness.owned), []);
    assert.equal(fs.readFileSync(path.join(witness.movedPath, "sentinel"), "utf8"), "original");
    assert.deepEqual(forwardMutationsAfterReplacement, []);
    rows.push({
      scenario: "callback-replaces-owned-ancestor",
      result: "undefined",
      mutationWitness: { before: witness.before, moved: witness.moved, replacement: witness.replacement },
      replacementPreserved: true,
      replacementRemainedEmpty: true,
      originalPreserved: true,
      forwardMkdirAfterReplacement: forwardMutationsAfterReplacement.length,
      libraryCleanup: "authority-lost-preserved",
    });
    fs.rmSync(directory, { recursive: true });
  }

  {
    const directory = path.join(sandbox, "nonempty-owned-directory");
    fs.mkdirSync(directory);
    let witness;
    const result = probePathSuffixAliasesSync({
      directory,
      left: path.join("same", "\u732b"),
      right: path.join("same", "\u72ac"),
      shouldProbeCaseVariants: () => {
        const [ownedName] = inventory(directory);
        assert.ok(ownedName);
        const owned = path.join(directory, ownedName);
        witness = { before: identity(owned), owned };
        fs.writeFileSync(path.join(owned, "sentinel"), "preserve");
        return false;
      },
    });
    assert.equal(result, undefined);
    assert.ok(witness);
    assert.deepEqual(identity(witness.owned), witness.before);
    assert.equal(fs.readFileSync(path.join(witness.owned, "sentinel"), "utf8"), "preserve");
    rows.push({
      scenario: "callback-makes-owned-directory-nonempty",
      result: "undefined",
      mutationWitness: witness.before,
      sentinelPreserved: true,
      libraryCleanup: "nonempty-preserved",
    });
    fs.rmSync(directory, { recursive: true });
  }

  const rootAfter = identity(sandbox);
  assert.deepEqual(rootAfter, rootBefore);
  assert.equal(empty(sandbox), true);
  const nativeLoadedAfterSuffix = nativeBinaryLoaded(binary);
  assert.equal(nativeLoadedAfterSuffix, mode === "require");
  console.log(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    packageManager: expected.manager,
    mode,
    source: expected.source,
    sourceMetadataProjection: true,
    rootPackage: { name: expected.rootPkg.name, version: expected.rootPkg.version, integrity: expected.rootIntegrity },
    rootIntegrity: { before: rootBefore, after: rootAfter, unchanged: true, finalInventoryEmpty: true },
    advancedModule: path.relative(consumer, advancedModule),
    compiledModules,
    probeSha256,
    metadataHelperSha256,
    addon: {
      path: path.relative(consumer, binary),
      sha256: hash(binary),
      nativeLoadedBeforePrime,
      bindingPrimedByHash: mode === "require",
      nativeLoadedAfterPrime,
      nativeLoadedAfterSuffix,
      suffixNativeExecutionClaimed: false,
    },
    rows,
  }));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
