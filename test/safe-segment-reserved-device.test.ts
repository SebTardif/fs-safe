import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveJsonDurableQueueEntryPaths } from "../src/json-durable-queue.js";
import {
  assertSafePathSegment,
  sanitizeSafePathSegment,
} from "../src/safe-path-segment.js";
import { expectFsSafeErrorSync } from "./helpers/security.js";

describe("safe path segments reject Windows reserved device names", () => {
  it.each(["CON", "nul", "COM1", "CON.txt"])("rejects %s", (segment) => {
    expectFsSafeErrorSync(() => assertSafePathSegment(segment), "invalid-path");
  });

  it("accepts an ordinary segment", () => {
    expect(assertSafePathSegment("notes")).toBe("notes");
  });

  it("rejects a reserved queue entry id before joining a json path", () => {
    const queueDir = path.join("/tmp", "fs-safe-queue");
    expectFsSafeErrorSync(
      () => resolveJsonDurableQueueEntryPaths(queueDir, "CON"),
      "invalid-path",
    );
  });

  it("does not sanitize a reserved device name into a usable segment", () => {
    expect(sanitizeSafePathSegment("CON")).toBeUndefined();
  });
});
