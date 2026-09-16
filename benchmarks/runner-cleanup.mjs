import fs from "node:fs";

export async function attemptBenchmarkCleanup(failures, action) {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

export function throwBenchmarkFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export async function finishBenchmarkInvocation(failures, after, message) {
  await attemptBenchmarkCleanup(failures, after);
  throwBenchmarkFailures(failures, message);
}

export async function finalizeBenchmarkRun({ initialFailures = [], cleanup, cleanups = [], workspace }) {
  const failures = [...initialFailures];

  if (cleanup) await attemptBenchmarkCleanup(failures, cleanup);
  for (const callback of [...cleanups].reverse()) {
    await attemptBenchmarkCleanup(failures, callback);
  }
  await attemptBenchmarkCleanup(failures, () => fs.rmSync(workspace, { recursive: true, force: true }));

  throwBenchmarkFailures(failures, "benchmark execution or cleanup failed");
}
