import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordEvidenceSources } from "../../application/investigation/recordEvidenceSources.js";

import { resolveEvidenceSourceList } from "../../application/EvidenceInputResolver.js";
import { projectManagedGraphEvidence } from "../../application/managed/ManagedApplicationGraphService.js";
import { readManagedGraphProjection } from "../../domain/managed/managedApplicationGraph.js";
import type { Evidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toolContract } from "../../contracts/toolContracts.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const graphContract = toolContract("project_managed_application_graph");

/** Register the managed application graph projection workflow tool. */
export const registerProjectManagedApplicationGraph = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    graphContract.name,
    toolRegistrationOptions(graphContract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        graphContract.name,
        context.mcpReq.signal,
        async () => {
          const parsed = graphContract.inputSchema.safeParse(input);
          let projectionInput: unknown = input;
          const selectedSources: Evidence[] = [];
          if (parsed.success) {
            const resolvedFields: {
              managed_artifact?: Evidence;
              managed_members?: Evidence;
              managed_native_boundaries?: Evidence;
            } = {};
            for (const [field, value] of [
              ["managed_artifact", parsed.data.managed_artifact],
              ["managed_members", parsed.data.managed_members],
              [
                "managed_native_boundaries",
                parsed.data.managed_native_boundaries,
              ],
            ] as const) {
              if (value === undefined) continue;
              const resolved = await resolveEvidenceSourceList(
                [value],
                field,
                options.session.evidenceForAnalysis.bind(options.session),
                {
                  operation: graphContract.name,
                  signal: context.mcpReq.signal,
                  resources: options.artifactResources,
                },
              );
              if (!resolved.ok)
                return server.delivery.toCallToolResult(
                  resolved,
                  graphContract,
                );
              const record = resolved.value.records[0];
              if (record === undefined)
                throw new Error(
                  "Managed graph source resolution lost its selection",
                );
              resolvedFields[field] = record;
              selectedSources.push(...resolved.value.sources);
            }
            projectionInput = { ...parsed.data, ...resolvedFields };
          }
          const request = readManagedGraphProjection(projectionInput);
          if (!request.ok)
            return server.delivery.toCallToolResult(request, graphContract);
          const result = await logToolExecution(
            options.logger,
            graphContract.name,
            () =>
              Promise.resolve(ok(projectManagedGraphEvidence(request.value))),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, graphContract);
          const recordedSources = recordEvidenceSources(
            options.recordEvidence,
            [
              ...selectedSources,
              request.value.sources.artifact?.evidence,
              request.value.sources.members?.evidence,
              request.value.sources.boundaries?.evidence,
            ].filter((source): source is Evidence => source !== undefined),
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(
              recordedSources,
              graphContract,
            );
          const recorded = options.recordEvidence?.(result.value);
          return server.delivery.toEvidenceToolResult(
            result.value,
            graphContract,
            recorded,
          );
        },
      ),
  );
};
