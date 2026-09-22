import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathRelativeEscape } from "../src/path.js";

describe("isPathRelativeEscape", () => {
  it("treats dotdot segments after a slash as escapes", () => {
    expect(isPathRelativeEscape("../secret")).toBe(true);
    expect(isPathRelativeEscape("foo/../../x")).toBe(true);
    expect(isPathRelativeEscape(`..${path.sep}secret`)).toBe(true);
    expect(isPathRelativeEscape("..")).toBe(true);
  });

  it("treats a backslash dotdot as an escape only on Windows", () => {
    expect(isPathRelativeEscape("..\\secret")).toBe(process.platform === "win32");
    expect(isPathRelativeEscape("foo\\..\\secret")).toBe(process.platform === "win32");
  });

  it("does not treat a normal relative path as an escape", () => {
    expect(isPathRelativeEscape("foo/bar")).toBe(false);
    expect(isPathRelativeEscape("")).toBe(false);
    expect(isPathRelativeEscape(".")).toBe(false);
  });

  it("treats an absolute path for this platform as an escape", () => {
    expect(isPathRelativeEscape("/secret")).toBe(true);
    expect(isPathRelativeEscape("C:\\secret")).toBe(process.platform === "win32");
    expect(isPathRelativeEscape("C:/secret")).toBe(process.platform === "win32");
  });
});
