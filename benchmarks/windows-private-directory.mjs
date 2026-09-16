import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function applyBenchmarkPrivateWindowsAcl(
  api,
  directory,
  { platform = process.platform, spawn = spawnSync } = {},
) {
  if (platform !== "win32") return;
  const acl = api.createIcaclsResetCommand(directory, { isDir: true });
  assert(acl, "Cannot resolve the benchmark workspace's Windows principal");
  const result = spawn(acl.command, acl.args, {
    windowsHide: true,
    timeout: 30_000,
    stdio: "ignore",
  });
  assert.equal(result.status, 0, "Cannot set the benchmark workspace's private Windows ACL");
}
