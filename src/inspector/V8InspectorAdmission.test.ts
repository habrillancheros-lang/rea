import { expect, it } from "vitest";

import { V8InspectorAdmission } from "./V8InspectorProvider.js";

const gate = (): { readonly promise: Promise<void>; release: () => void } => {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

it("does not make one inspector admission wait on another", async () => {
  const first = new V8InspectorAdmission();
  const second = new V8InspectorAdmission();
  const held = gate();
  const running = first.run("observe_javascript_runtime", () => held.promise);
  const closing = first.close();
  let secondRan = false;
  await second.run("list_javascript_runtime_targets", async () => {
    secondRan = true;
  });
  expect(secondRan).toBe(true);
  let firstFinished = false;
  void closing.finally(() => {
    firstFinished = true;
  });
  await Promise.resolve();
  expect(firstFinished).toBe(false);
  held.release();
  await running;
  await closing;
});

it("holds a later operation until the same admission finishes closing", async () => {
  const admission = new V8InspectorAdmission();
  const held = gate();
  const running = admission.run(
    "observe_javascript_runtime",
    () => held.promise,
  );
  const closing = admission.close();
  let proceeded = false;
  const queued = admission.run("list_javascript_runtime_targets", async () => {
    proceeded = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(proceeded).toBe(false);
  held.release();
  await running;
  await closing;
  await queued;
  expect(proceeded).toBe(true);
});
