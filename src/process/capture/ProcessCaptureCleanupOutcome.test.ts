import { expect, it } from "vitest";
import { emptyProcessCapture } from "../../domain/process/processCapture.fixture.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import {
  releaseProcessResources,
  resolveProcessResult,
  type ProcessCaptureCleanupOutcome,
  type PendingProcessCapture,
} from "./ProcessCaptureLifecycle.js";

const pendingCapture = (): PendingProcessCapture => {
  const { cleanup, ...capture } = emptyProcessCapture();
  void cleanup;
  return capture;
};

// An injected ownership result exercises finalization without claiming host
// process/TTY behavior or sending a signal to a real process.
const observedCleanup = (signaled: boolean, rendererFailure?: () => boolean) =>
  releaseProcessResources({
    timers: new Set(),
    terminal: { pid: 321 },
    renderer:
      rendererFailure === undefined
        ? undefined
        : {
            dispose: async () => {
              if (rendererFailure()) throw new Error("renderer cleanup denied");
            },
          },
    runId: "cleanup-facts-fixture",
    temporaryRoot: "/fixture/root",
    host: {
      platform: "linux",
      cleanupProcessGroup: async () => ({ cleaned: true, signaled }),
      removeTemporaryRoot: async () => undefined,
    },
  });

const intervention = {
  scope: "process",
  reason: expect.stringContaining("cleanup sent termination signals"),
};

it("reports cleanup intervention even when settlement had already quiesced", async () => {
  const cleanup = await observedCleanup(true);
  const capture = resolveProcessResult(pendingCapture(), undefined, cleanup);
  expect(capture.settlement).toMatchObject({
    state: "quiesced",
    cleanup_outcome: "cleaned",
  });
  expect(capture.residual_unknowns).toContainEqual(intervention);
  expect(capture.cleanup.owned_process_group).toBe("verified");
});

it("keeps non-signaling cleanup distinct from intervention", async () => {
  const cleanup = await observedCleanup(false);
  const capture = resolveProcessResult(pendingCapture(), undefined, cleanup);
  expect(capture.settlement.cleanup_outcome).toBe("not_required");
  expect(capture.residual_unknowns).not.toContainEqual(intervention);
});

it("updates a validated capture once and does not duplicate intervention facts", async () => {
  const cleanup = await observedCleanup(true);
  const capture = resolveProcessResult(
    emptyProcessCapture(),
    undefined,
    cleanup,
  );
  expect(capture.settlement.cleanup_outcome).toBe("cleaned");
  const repeated = resolveProcessResult(capture, undefined, cleanup);
  expect(repeated.residual_unknowns).toEqual(capture.residual_unknowns);
  expect(
    repeated.residual_unknowns.filter((unknown) =>
      unknown.reason.includes("cleanup sent termination signals"),
    ),
  ).toHaveLength(1);
});

it("retains intervention in partial facts without replacing the execution failure", async () => {
  const cleanup = await observedCleanup(true);
  const failure = new Error("final snapshot failed");
  try {
    resolveProcessResult(pendingCapture(), failure, cleanup);
    throw new Error("Expected the execution failure");
  } catch (cause: unknown) {
    if (!(cause instanceof ProcessCaptureError)) throw cause;
    expect(cause.cause).toBe(failure);
    expect(cause.cleanupIncomplete).toBe(false);
    expect(cause.partialObservation).toMatchObject({
      capture: {
        settlement: { cleanup_outcome: "cleaned" },
        residual_unknowns: expect.arrayContaining([intervention]),
      },
    });
  }
});

it("keeps failed cleanup authoritative while retaining its known intervention", async () => {
  let rendererFails = true;
  const cleanup = await observedCleanup(true, () => rendererFails);
  try {
    resolveProcessResult(pendingCapture(), undefined, cleanup);
    throw new Error("Expected incomplete cleanup");
  } catch (cause: unknown) {
    if (!(cause instanceof ProcessCaptureError)) throw cause;
    expect(cause.cleanupIncomplete).toBe(true);
    expect(cause.partialObservation).toMatchObject({
      capture: {
        settlement: { cleanup_outcome: "failed" },
        residual_unknowns: expect.arrayContaining([intervention]),
      },
    });
  } finally {
    rendererFails = false;
    await cleanup.cleanupLease?.release();
  }
});

it("does not invent intervention facts for a historical report", async () => {
  const observed = await observedCleanup(true);
  const historical: ProcessCaptureCleanupOutcome = {
    report: observed.report,
    cleanupLease: undefined,
  };
  const capture = resolveProcessResult(
    emptyProcessCapture(),
    undefined,
    historical,
  );
  expect(capture.settlement.cleanup_outcome).toBe("not_required");
  expect(capture.residual_unknowns).not.toContainEqual(intervention);
});

it("preserves saved intervention when a later report has no signal fact", async () => {
  const cleanup = await observedCleanup(true);
  const capture = resolveProcessResult(pendingCapture(), undefined, cleanup);
  const historical: ProcessCaptureCleanupOutcome = {
    report: cleanup.report,
    cleanupLease: undefined,
  };
  const restored = resolveProcessResult(capture, undefined, historical);
  expect(restored.settlement).toEqual(capture.settlement);
  expect(restored.residual_unknowns).toEqual(capture.residual_unknowns);
});
