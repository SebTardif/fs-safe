import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathRelativeEscape } from "../src/path.js";

describe("isPathRelativeEscape", () => {
  it("treats .. segments on either slash as escapes", () => {
    expect(isPathRelativeEscape("../secret")).toBe(true);
    expect(isPathRelativeEscape("..\\secret")).toBe(true);
    expect(isPathRelativeEscape("foo/../../x")).toBe(true);
    expect(isPathRelativeEscape(`..${path.posix.sep}secret`)).toBe(true);
    expect(isPathRelativeEscape(`..${path.win32.sep}secret`)).toBe(true);
    expect(isPathRelativeEscape("..")).toBe(true);
  });

  it("does not treat a normal relative path as an escape", () => {
    expect(isPathRelativeEscape("foo/bar")).toBe(false);
    expect(isPathRelativeEscape("")).toBe(false);
    expect(isPathRelativeEscape(".")).toBe(false);
  });

  it("treats POSIX and Windows absolute paths as escapes", () => {
    expect(isPathRelativeEscape("/secret")).toBe(true);
    expect(isPathRelativeEscape("C:\\secret")).toBe(true);
    expect(isPathRelativeEscape("C:/secret")).toBe(true);
  });
});
