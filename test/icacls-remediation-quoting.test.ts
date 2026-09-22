import { describe, expect, it } from "vitest";
import { formatPermissionRemediation, type PermissionCheck } from "../src/permissions.js";
import {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
} from "../src/permissions-windows.js";

const windowsAcl: PermissionCheck = {
  ok: true,
  isSymlink: false,
  isDir: false,
  mode: null,
  bits: null,
  source: "windows-acl",
  worldWritable: false,
  groupWritable: false,
  worldReadable: false,
  groupReadable: false,
};

function quotedPathSegment(command: string): string {
  const open = command.indexOf('"');
  const close = command.indexOf('"', open + 1);
  return command.slice(open, close + 1);
}

describe("icacls remediation quoting", () => {
  it("escapes percent signs in a pasted path", () => {
    const formatted = formatIcaclsResetCommand(String.raw`C:\Secret\%PATH%.txt`, {
      isDir: false,
      env: { USERNAME: "me" },
    });
    const pathSegment = quotedPathSegment(formatted);
    expect(pathSegment).toBe(String.raw`"C:\Secret\%%PATH%%.txt"`);
    expect(formatted).not.toContain(String.raw`"C:\Secret\%PATH%.txt"`);
  });

  it("escapes percent signs in a resolved username", () => {
    const formatted = formatIcaclsResetCommand(String.raw`C:\Secrets\token.txt`, {
      isDir: false,
      env: { USERNAME: "a%b" },
    });
    expect(formatted).toContain('"a%%b:F"');
    expect(formatted).not.toContain('"a%b:F"');
  });

  it("keeps the unknown-user %USERNAME% placeholder expandable", () => {
    const formatted = formatIcaclsResetCommand(String.raw`C:\Secrets\token.txt`, {
      isDir: false,
      env: {},
      userInfo: () => ({}),
    });
    expect(formatted).toContain('"%USERNAME%:F"');
    expect(formatted).not.toContain("%%USERNAME%%");
    expect(formatted.split("%USERNAME%").length - 1).toBe(1);
  });

  it("rejects a path that contains a double quote", () => {
    expect(() => formatIcaclsResetCommand("C:\\Secret\"token.txt", {
      isDir: false,
      env: { USERNAME: "me" },
    })).toThrow(Error);
  });

  it("rejects newlines in a path or resolved principal", () => {
    const opts = { isDir: false, env: { USERNAME: "me" } };
    expect(() => formatIcaclsResetCommand("C:\\Secret\rfile.txt", opts)).toThrow(Error);
    expect(() => formatIcaclsResetCommand("C:\\Secret\nfile.txt", opts)).toThrow(Error);
    expect(() => formatIcaclsResetCommand(String.raw`C:\Secrets\token.txt`, {
      isDir: false,
      env: { USERNAME: "a\nb" },
    })).toThrow(Error);
    expect(() => formatIcaclsResetCommand(String.raw`C:\Secrets\token.txt`, {
      isDir: false,
      env: { USERNAME: "a\"b" },
    })).toThrow(Error);
  });

  it("escapes display text without rewriting icacls argv", () => {
    const targetPath = String.raw`C:\Secret\%PATH%.txt`;
    const reset = createIcaclsResetCommand(targetPath, {
      isDir: false,
      env: { USERNAME: "a%b" },
    });
    expect(reset).not.toBeNull();
    expect(reset?.args).toEqual([
      targetPath,
      "/inheritance:r",
      "/grant:r",
      "a%b:F",
      "/grant:r",
      "*S-1-5-18:F",
    ]);
    expect(quotedPathSegment(reset?.display ?? "")).toBe(String.raw`"C:\Secret\%%PATH%%.txt"`);
    expect(reset?.display).toContain('"a%%b:F"');
  });

  it("escapes Windows remediation text from formatPermissionRemediation", () => {
    const formatted = formatPermissionRemediation({
      targetPath: String.raw`C:\Secret\%PATH%.txt`,
      perms: windowsAcl,
      isDir: false,
      posixMode: 0o600,
      env: { USERNAME: "me" },
    });
    expect(quotedPathSegment(formatted)).toBe(String.raw`"C:\Secret\%%PATH%%.txt"`);
  });
});
