import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";

import { projectAndroidApplicationEvidence } from "../../application/android/AndroidApplicationService.js";
import { projectAppleApplicationEvidence } from "../../application/apple/AppleApplicationService.js";
import { projectHarmonyApplicationEvidence } from "../../application/harmony/HarmonyApplicationService.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import { applicationInventoryProjectionInputSchema } from "../../domain/mobileApplicationGraphProjection.js";
import { toolContract } from "../../contracts/toolContracts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type { InventoryProjectionEvidenceResult } from "../../application/InventoryProjectionEvidence.js";
import { resolveEvidenceSourceList } from "../../application/EvidenceInputResolver.js";
import { recordEvidenceSources } from "../../application/investigation/recordEvidenceSources.js";
import type { Evidence } from "../../domain/evidence.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

/** Register execution-free mobile application inventory projection tools. */
export const registerProjectMobileApplicationGraphTools = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  registerProjection({
    server,
    options,
    contract: toolContract("project_android_application_graph"),
    project: projectAndroidApplicationEvidence,
  });
  registerProjection({
    server,
    options,
    contract: toolContract("project_apple_application_graph"),
    project: projectAppleApplicationEvidence,
  });
  registerProjection({
    server,
    options,
    contract: toolContract("project_harmony_application_graph"),
    project: projectHarmonyApplicationEvidence,
  });
};

const registerProjection = (context: {
  readonly server: EvidenceMcpServer;
  readonly options: ApplicationToolRegistration;
  readonly contract: (typeof APPLICATION_TOOL_CONTRACTS)[number];
  readonly project: (
    input: unknown,
  ) => Result<InventoryProjectionEvidenceResult, AnalysisError>;
}): void => {
  const { server, options, contract, project } = context;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input: unknown, request: ServerContext) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        request.mcpReq.signal,
        async () => {
          const parsed =
            applicationInventoryProjectionInputSchema.safeParse(input);
          let selectedSources: readonly Evidence[] = [];
          let resolvedInput: unknown = input;
          if (parsed.success) {
            const resolved = await resolveEvidenceSourceList(
              parsed.data.inventory_evidence,
              "inventory_evidence",
              options.evidenceById,
              {
                operation: contract.name,
                signal: request.mcpReq.signal,
                resources: options.artifactResources,
              },
            );
            if (!resolved.ok)
              return server.delivery.toCallToolResult(resolved, contract);
            selectedSources = resolved.value.sources;
            resolvedInput = {
              ...parsed.data,
              inventory_evidence: [...resolved.value.records],
            };
          }
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () => Promise.resolve(project(resolvedInput)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recordedSources = recordEvidenceSources(
            options.recordEvidence,
            [...selectedSources, ...result.value.sources],
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(recordedSources, contract);
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value.evidence,
          );
        },
      ),
  );
};
