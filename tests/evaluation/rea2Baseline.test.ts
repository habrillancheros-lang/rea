import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { estimateTokenCount } from "tokenx";
import { expect, it } from "vitest";

import { createServer } from "../../src/server/createServer.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import type { Evidence } from "../../src/domain/evidence.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../src/contracts/functionComparisonExample.js";
import {
  FUNCTION_COMPARISON_EVIDENCE,
  INVESTIGATION_EXAMPLES,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_COMPARISON_EVIDENCE,
} from "../../src/contracts/investigationExamples.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";

const MEASURED_RUNS = 3;
const WARMUP_RUNS = 1;

type CaseForm = "inline" | "retained" | "evidence-file";

interface CaseDefinition {
  readonly name: string;
  readonly operation: string;
  readonly form: CaseForm;
  readonly arguments: Record<string, unknown>;
}

interface CaseMeasurement {
  readonly name: string;
  readonly operation: string;
  readonly form: CaseForm;
  readonly input_bytes: number;
  readonly input_tokens: number;
  readonly output_bytes: number;
  readonly output_tokens: number;
  readonly elapsed_ms_median: number;
  readonly cpu_ms_median: number;
  readonly rss_delta_bytes_median: number;
  readonly passes: number;
}

interface BaselineReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly node_version: string;
  readonly platform: string;
  readonly architecture: string;
  readonly limitations: readonly string[];
  readonly catalogs: readonly CatalogMeasurement[];
  readonly cases: readonly CaseMeasurement[];
}

interface CatalogMeasurement {
  readonly profile: string;
  readonly input_schema_profile: string;
  readonly output_schema_profile: string;
  readonly tools: number;
  readonly bytes: number;
  readonly tokens: number;
}

interface CatalogProfile {
  readonly profile: string;
  readonly input: string;
  readonly output: string;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const tokenCount = (value: unknown): number =>
  estimateTokenCount(JSON.stringify(value));

const measured = async (
  client: Client,
  definition: CaseDefinition,
): Promise<CaseMeasurement> => {
  const inputText = JSON.stringify(definition.arguments);
  let output: Evidence | undefined;
  const elapsed: number[] = [];
  const cpu: number[] = [];
  const rss: number[] = [];

  for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run += 1) {
    const cpuBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const response = await client.callTool({
      name: definition.operation,
      arguments: definition.arguments,
    });
    const finished = performance.now();
    const cpuDelta = process.cpuUsage(cpuBefore);
    expect(
      response.isError,
      `${definition.name}: ${JSON.stringify(response)}`,
    ).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    if (run >= WARMUP_RUNS) {
      output = evidence;
      elapsed.push(finished - started);
      cpu.push((cpuDelta.user + cpuDelta.system) / 1000);
      rss.push(process.memoryUsage().rss - rssBefore);
    }
  }

  if (output === undefined)
    throw new Error(`${definition.name} produced no Evidence`);
  const outputText = JSON.stringify(output);
  return {
    name: definition.name,
    operation: definition.operation,
    form: definition.form,
    input_bytes: Buffer.byteLength(inputText),
    input_tokens: tokenCount(definition.arguments),
    output_bytes: Buffer.byteLength(outputText),
    output_tokens: tokenCount(output),
    elapsed_ms_median: median(elapsed),
    cpu_ms_median: median(cpu),
    rss_delta_bytes_median: median(rss),
    passes: MEASURED_RUNS,
  };
};

const catalogFor = async (
  session: ReturnType<typeof createTestBinarySession>,
  profile: CatalogProfile,
): Promise<CatalogMeasurement> => {
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...process.env,
        REA_MCP_INPUT_SCHEMA_PROFILE: profile.input,
        REA_MCP_OUTPUT_SCHEMA_PROFILE: profile.output,
      },
    },
  );
  const client = new Client({ name: "rea2-catalog", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const bytes = Buffer.byteLength(JSON.stringify(listed.tools));
    return {
      profile: profile.profile,
      input_schema_profile: profile.input,
      output_schema_profile: profile.output,
      tools: listed.tools.length,
      bytes,
      tokens: tokenCount(listed.tools),
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
};

const writeReport = async (report: BaselineReport): Promise<string | null> => {
  const outputRoot = process.env.REA2_BASELINE_OUTPUT;
  if (outputRoot === undefined || outputRoot.length === 0) return null;
  await mkdir(outputRoot, { recursive: true });
  const path = join(outputRoot, "rea2-baseline.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};

const CATALOG_PROFILES: readonly CatalogProfile[] = [
  { profile: "default", input: "compact", output: "full" },
  { profile: "compact-output", input: "compact", output: "compact" },
  { profile: "no-output", input: "compact", output: "off" },
  { profile: "full-input-no-output", input: "full", output: "off" },
];

const definitionsFor = (sourcePath: string): readonly CaseDefinition[] => {
  const dossier = FUNCTION_COMPARISON_EXAMPLE.left;
  return [
    {
      name: "compare_functions_inline",
      operation: "compare_functions",
      form: "inline",
      arguments: {
        left: FUNCTION_COMPARISON_EXAMPLE.left,
        right: FUNCTION_COMPARISON_EXAMPLE.right,
      },
    },
    {
      name: "compare_functions_retained",
      operation: "compare_functions",
      form: "retained",
      arguments: {
        left: {
          kind: "retained-evidence",
          evidence_id: FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
        },
        right: {
          kind: "retained-evidence",
          evidence_id: FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
        },
      },
    },
    {
      name: "build_call_path_inline",
      operation: "build_call_path",
      form: "inline",
      arguments: {
        ...INVESTIGATION_EXAMPLES.build_call_path,
        functions: [dossier],
      },
    },
    {
      name: "build_call_path_retained",
      operation: "build_call_path",
      form: "retained",
      arguments: {
        ...INVESTIGATION_EXAMPLES.build_call_path,
        functions: [
          { kind: "retained-evidence", evidence_id: dossier.evidence_id },
        ],
      },
    },
    {
      name: "find_changed_behavior_inline",
      operation: "find_changed_behavior",
      form: "inline",
      arguments: { comparisons: [FUNCTION_COMPARISON_EVIDENCE] },
    },
    {
      name: "find_changed_behavior_retained",
      operation: "find_changed_behavior",
      form: "retained",
      arguments: {
        comparisons: [
          {
            kind: "retained-evidence",
            evidence_id: FUNCTION_COMPARISON_EVIDENCE.evidence_id,
          },
        ],
      },
    },
    {
      name: "compare_process_captures_inline",
      operation: "compare_process_captures",
      form: "inline",
      arguments: {
        left: PROCESS_CAPTURE_REFERENCE,
        right: PROCESS_CAPTURE_RECONSTRUCTION,
      },
    },
    {
      name: "compare_process_captures_file",
      operation: "compare_process_captures",
      form: "evidence-file",
      arguments: {
        left: {
          kind: "evidence-file",
          path: sourcePath,
          evidence_id: PROCESS_CAPTURE_REFERENCE.evidence_id,
        },
        right: {
          kind: "evidence-file",
          path: sourcePath,
          evidence_id: PROCESS_CAPTURE_RECONSTRUCTION.evidence_id,
        },
      },
    },
    {
      name: "correlate_static_and_runtime_inline",
      operation: "correlate_static_and_runtime",
      form: "inline",
      arguments: INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
    },
    {
      name: "correlate_static_and_runtime_retained",
      operation: "correlate_static_and_runtime",
      form: "retained",
      arguments: {
        ...INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
        static_comparisons: [
          {
            kind: "retained-evidence",
            evidence_id: FUNCTION_COMPARISON_EVIDENCE.evidence_id,
          },
        ],
        runtime_comparisons: [
          {
            kind: "retained-evidence",
            evidence_id: PROCESS_COMPARISON_EVIDENCE.evidence_id,
          },
        ],
      },
    },
  ];
};

const expectCatalogReduction = (
  catalogs: readonly CatalogMeasurement[],
): void => {
  const defaultCatalog = catalogs.find(({ profile }) => profile === "default");
  const compactOutputCatalog = catalogs.find(
    ({ profile }) => profile === "compact-output",
  );
  expect(defaultCatalog).toBeDefined();
  expect(compactOutputCatalog).toBeDefined();
  expect(compactOutputCatalog!.tools).toBe(defaultCatalog!.tools);
  expect(compactOutputCatalog!.tokens).toBeLessThan(defaultCatalog!.tokens);
};

const expectReferenceSavings = (cases: readonly CaseMeasurement[]): void => {
  const byName = new Map(
    cases.map((measurement) => [measurement.name, measurement]),
  );
  for (const [inlineName, referenceName] of [
    ["compare_functions_inline", "compare_functions_retained"],
    ["build_call_path_inline", "build_call_path_retained"],
    ["find_changed_behavior_inline", "find_changed_behavior_retained"],
    ["compare_process_captures_inline", "compare_process_captures_file"],
    [
      "correlate_static_and_runtime_inline",
      "correlate_static_and_runtime_retained",
    ],
  ] as const) {
    const inline = byName.get(inlineName);
    const reference = byName.get(referenceName);
    expect(inline, inlineName).toBeDefined();
    expect(reference, referenceName).toBeDefined();
    expect(reference!.input_tokens, referenceName).toBeLessThan(
      inline!.input_tokens,
    );
  }
};

it("records the agent-visible cost of representative composed workflows", async () => {
  // Fixtures exercise the shared MCP boundary, not real providers. The
  // numbers describe protocol and in-process overhead, never provider time.
  const session = createTestBinarySession(() => {
    throw new Error("Composed workflow baseline must not launch a provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "rea2-baseline", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const root = await mkdtemp(join(tmpdir(), "rea2-baseline-"));
  const sourcePath = join(root, "sources.json");
  const recorded: readonly Evidence[] = [
    FUNCTION_COMPARISON_EXAMPLE.left,
    FUNCTION_COMPARISON_EXAMPLE.right,
    FUNCTION_COMPARISON_EVIDENCE,
    PROCESS_CAPTURE_REFERENCE,
    PROCESS_CAPTURE_RECONSTRUCTION,
    PROCESS_COMPARISON_EVIDENCE,
  ];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const record of recorded)
      expect(session.recordEvidence(record).ok).toBe(true);
    await writeFile(
      sourcePath,
      JSON.stringify(
        createEvidenceBundle([
          PROCESS_CAPTURE_REFERENCE,
          PROCESS_CAPTURE_RECONSTRUCTION,
        ]),
      ),
    );

    const catalogs: CatalogMeasurement[] = [];
    for (const profile of CATALOG_PROFILES)
      catalogs.push(await catalogFor(session, profile));
    expectCatalogReduction(catalogs);
    const cases: CaseMeasurement[] = [];
    for (const definition of definitionsFor(sourcePath))
      cases.push(await measured(client, definition));
    expectReferenceSavings(cases);

    const report: BaselineReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      limitations: [
        "Simulated provider session; no real analysis provider was launched.",
        "CPU and RSS are in-process deltas and include the MCP client and test runner.",
        "Token counts are tokenx estimates, not provider billing values.",
      ],
      catalogs,
      cases,
    };
    const path = await writeReport(report);
    if (path !== null) console.log(`REA 2 baseline written to ${path}`);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
