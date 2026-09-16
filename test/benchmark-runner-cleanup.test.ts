import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalizeBenchmarkRun,
  finishBenchmarkInvocation,
} from "../benchmarks/runner-cleanup.mjs";
import { validateMeasuredResult } from "../benchmarks/measured-distribution.mjs";

describe("benchmark runner cleanup", () => {
  it("attempts every cleanup and removes the workspace before surfacing failures", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-benchmark-cleanup-"));
    fs.writeFileSync(path.join(workspace, "orphan"), "orphan");
    const events: string[] = [];
    const coreFailure = new Error("core cleanup failed");
    const callbackFailure = new Error("callback cleanup failed");

    let caught: unknown;
    let workspaceRemoved = false;
    try {
      await finalizeBenchmarkRun({
        cleanup: async () => {
          events.push("core");
          throw coreFailure;
        },
        cleanups: [
          async () => events.push("first"),
          async () => {
            events.push("second");
            throw callbackFailure;
          },
        ],
        workspace,
      });
    } catch (error) {
      caught = error;
    } finally {
      workspaceRemoved = !fs.existsSync(workspace);
      fs.rmSync(workspace, { recursive: true, force: true });
    }

    expect(events).toEqual(["core", "second", "first"]);
    expect(workspaceRemoved).toBe(true);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([coreFailure, callbackFailure]);
  });

  it("preserves the primary failure alongside invocation and cleanup failures", async () => {
    const acquisitionFailure = new Error("acquisition failed");
    const afterFailure = new Error("after failed");
    let caught: unknown;
    try {
      await finishBenchmarkInvocation(
        [acquisitionFailure],
        async () => { throw afterFailure; },
        "invocation failed",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([acquisitionFailure, afterFailure]);

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-benchmark-primary-"));
    try {
      await expect(finalizeBenchmarkRun({
        initialFailures: [acquisitionFailure],
        cleanups: [],
        workspace,
      })).rejects.toBe(acquisitionFailure);
      expect(fs.existsSync(workspace)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("recomputes measured summaries and rejects incomplete or invalid samples", () => {
    const result = {
      name: "example",
      iterations: 10,
      samplesUs: [3, 1, 2],
      minUs: 1,
      medianUs: 2,
      maxUs: 3,
    };
    expect(() => validateMeasuredResult(result, 3)).not.toThrow();
    expect(() => validateMeasuredResult({ ...result, samplesUs: [1, 2] }, 3))
      .toThrow("sample set is incomplete");
    expect(() => validateMeasuredResult({ ...result, samplesUs: [1, Number.NaN, 3] }, 3))
      .toThrow("invalid duration");
    expect(() => validateMeasuredResult({ ...result, medianUs: 3 }, 3))
      .toThrow("median does not match");
    expect(() => validateMeasuredResult({ name: "skipped", skipped: "" }, 3))
      .toThrow("skip reason is empty");
  });
});
