import { expect, it } from "vitest";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MAXIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
  MAXIMUM_DEBUGGER_MAX_SESSIONS,
  MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MINIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
  MINIMUM_DEBUGGER_MAX_SESSIONS,
} from "../domain/analysisResourceLimits.js";
import { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import { parseEnvironment } from "./environment.js";
import {
  DEBUGGER_COMMAND_DEADLINE_SETTING,
  DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
  DEBUGGER_MAX_PENDING_COMMANDS_SETTING,
  DEBUGGER_MAX_SESSIONS_SETTING,
  debuggerCommandDeadlineConstraint,
  debuggerMaxCommandOutputBytesConstraint,
  debuggerMaxPendingCommandsConstraint,
  debuggerMaxSessionsConstraint,
  parseDebuggerSessionLimits,
  resolveDebuggerSessionLimits,
} from "./debuggerSessionLimits.js";

it("uses the shared defaults when the settings are unset", () => {
  const parsed = parseDebuggerSessionLimits({});
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.commandDeadline).toMatchObject({
    setting: DEBUGGER_COMMAND_DEADLINE_SETTING,
    value: 120_000,
    source: "default",
    minimum: MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
    maximum: MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
    unit: "ms",
  });
  expect(parsed.value.maxSessions).toMatchObject({
    setting: DEBUGGER_MAX_SESSIONS_SETTING,
    value: 8,
    source: "default",
    minimum: MINIMUM_DEBUGGER_MAX_SESSIONS,
    maximum: MAXIMUM_DEBUGGER_MAX_SESSIONS,
    unit: "sessions",
  });
  expect(parsed.value.maxPendingCommands).toMatchObject({
    setting: DEBUGGER_MAX_PENDING_COMMANDS_SETTING,
    value: 16,
    source: "default",
    minimum: MINIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
    maximum: MAXIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
    unit: "commands",
  });
  expect(parsed.value.maxCommandOutputBytes).toMatchObject({
    setting: DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
    value: 16 * 1024 * 1024,
    source: "default",
    minimum: MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    maximum: MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    unit: "bytes",
  });
});

it("accepts one in-range override for each shared debugger cap", () => {
  const parsed = parseDebuggerSessionLimits({
    [DEBUGGER_COMMAND_DEADLINE_SETTING]: "1000",
    [DEBUGGER_MAX_SESSIONS_SETTING]: "2",
    [DEBUGGER_MAX_PENDING_COMMANDS_SETTING]: "3",
    [DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING]: "4096",
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.commandDeadline).toMatchObject({
    value: 1000,
    source: "setting",
  });
  expect(parsed.value.maxSessions).toMatchObject({
    value: 2,
    source: "setting",
  });
  expect(parsed.value.maxPendingCommands).toMatchObject({
    value: 3,
    source: "setting",
  });
  expect(parsed.value.maxCommandOutputBytes).toMatchObject({
    value: 4096,
    source: "setting",
  });
});

it.each([
  [DEBUGGER_COMMAND_DEADLINE_SETTING, "0", debuggerCommandDeadlineConstraint],
  [DEBUGGER_MAX_SESSIONS_SETTING, "65", debuggerMaxSessionsConstraint],
  [
    DEBUGGER_MAX_PENDING_COMMANDS_SETTING,
    "00",
    debuggerMaxPendingCommandsConstraint,
  ],
  [
    DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
    String(MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES + 1),
    debuggerMaxCommandOutputBytesConstraint,
  ],
])(
  "rejects invalid %s at the setting boundary",
  (setting, value, constraint) => {
    const parsed = parseDebuggerSessionLimits({ [setting]: value });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ConfigurationError);
    expect(parsed.error.settings).toEqual([{ setting, constraint }]);
    const startup = parseEnvironment({ [setting]: value });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    expect(projectAnalysisError(startup.error)).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [{ setting, constraint }] },
    });
  },
);

it("names the session setting on a Rizin capacity refusal", async () => {
  const manager = new RizinDebugSessionManager(
    { [DEBUGGER_MAX_SESSIONS_SETTING]: "1" },
    { platform: "linux" },
  );
  const first = manager.start({
    path: "/tmp/rea-debugger-limit",
    inferior_tty: "/no/such/rea-debugger-tty",
  });
  const blocked = await manager.start({
    path: "/tmp/rea-debugger-limit-2",
    inferior_tty: "/no/such/rea-debugger-tty",
  });
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("expected the session cap to refuse");
  expect(projectAnalysisError(blocked.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "memory",
      reported_limits: {
        setting: DEBUGGER_MAX_SESSIONS_SETTING,
        effective_value: 1,
        source: "setting",
        minimum: MINIMUM_DEBUGGER_MAX_SESSIONS,
        maximum: MAXIMUM_DEBUGGER_MAX_SESSIONS,
        unit: "sessions",
        restart_required: true,
        max_sessions: 1,
        active_or_reserved_sessions: 1,
      },
    },
  });
  await first;
});

it("does not let one Rizin manager consume another manager's session cap", async () => {
  const tight = new RizinDebugSessionManager(
    { [DEBUGGER_MAX_SESSIONS_SETTING]: "1" },
    { platform: "linux" },
  );
  const independent = new RizinDebugSessionManager(
    {},
    { platform: "linux", maxSessions: 0 },
  );
  const reserved = tight.start({
    path: "/tmp/rea-debugger-limit",
    inferior_tty: "/no/such/rea-debugger-tty",
  });
  const blocked = await independent.start({
    path: "/tmp/rea-debugger-limit",
    inferior_tty: "/no/such/rea-debugger-tty",
  });
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("expected the independent cap to refuse");
  expect(projectAnalysisError(blocked.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      reported_limits: {
        setting: DEBUGGER_MAX_SESSIONS_SETTING,
        effective_value: 0,
        source: "runtime",
        minimum: MINIMUM_DEBUGGER_MAX_SESSIONS,
        maximum: MAXIMUM_DEBUGGER_MAX_SESSIONS,
      },
    },
  });
  const stillOpen = await tight.start({
    path: "/tmp/rea-debugger-limit-2",
    inferior_tty: "/no/such/rea-debugger-tty",
  });
  expect(stillOpen.ok).toBe(false);
  if (stillOpen.ok)
    throw new Error("expected the first manager to stay capped");
  expect(projectAnalysisError(stillOpen.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      reported_limits: {
        effective_value: 1,
        source: "setting",
        active_or_reserved_sessions: 1,
      },
    },
  });
  await reserved;
});

it("refuses an invalid GDB deadline before a session starts", () => {
  expect(
    () =>
      new GdbSessionManager({
        environment: { [DEBUGGER_COMMAND_DEADLINE_SETTING]: "0" },
      }),
  ).toThrow(ConfigurationError);
  try {
    new GdbSessionManager({
      environment: { [DEBUGGER_COMMAND_DEADLINE_SETTING]: "0" },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    if (!(error instanceof ConfigurationError)) return;
    expect(projectAnalysisError(error)).toMatchObject({
      code: "configuration_invalid",
      details: {
        settings: [
          {
            setting: DEBUGGER_COMMAND_DEADLINE_SETTING,
            constraint: debuggerCommandDeadlineConstraint,
          },
        ],
      },
    });
  }
  expect(
    resolveDebuggerSessionLimits({
      [DEBUGGER_COMMAND_DEADLINE_SETTING]: "1500",
    }).commandDeadline,
  ).toMatchObject({ value: 1500, source: "setting" });
});
