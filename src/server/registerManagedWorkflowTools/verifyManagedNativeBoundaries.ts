import { workflowUnknownInput } from "../../application/investigation/WorkflowUnknown.js";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordEvidenceSources } from "../../application/investigation/recordEvidenceSources.js";

import { resolveEvidenceSourceList } from "../../application/EvidenceInputResolver.js";
import { executeManagedNativeBoundaries } from "../../application/managed/ManagedNativeVerificationService.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toolContract } from "../../contracts/toolContracts.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const nativeVerificationContract = toolContract(
  "verify_managed_native_boundaries",
);

/** Register the managed/native boundary verification workflow tool. */
export const registerVerifyManagedNativeBoundaries = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    nativeVerificationContract.name,
    toolRegistrationOptions(nativeVerificationContract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        nativeVerificationContract.name,
        context.mcpReq.signal,
        async () => {
          const parsed =
            nativeVerificationContract.inputSchema.safeParse(input);
          if (!parsed.success) {
            const rejected = executeManagedNativeBoundaries(input);
            if (rejected.ok)
              throw new Error(
                "Invalid managed native verification input was accepted",
              );
            return server.delivery.toCallToolResult(
              rejected,
              nativeVerificationContract,
            );
          }
          const boundaries = await resolveEvidenceSourceList(
            [parsed.data.managed_boundaries],
            "managed_boundaries",
            options.session.evidenceForAnalysis.bind(options.session),
            {
              operation: nativeVerificationContract.name,
              signal: context.mcpReq.signal,
              resources: options.artifactResources,
            },
          );
          if (!boundaries.ok)
            return server.delivery.toCallToolResult(
              boundaries,
              nativeVerificationContract,
            );
          const observations = await resolveEvidenceSourceList(
            parsed.data.native_observations,
            "native_observations",
            options.session.evidenceForAnalysis.bind(options.session),
            {
              operation: nativeVerificationContract.name,
              signal: context.mcpReq.signal,
              resources: options.artifactResources,
            },
          );
          if (!observations.ok)
            return server.delivery.toCallToolResult(
              observations,
              nativeVerificationContract,
            );
          const boundary = boundaries.value.records[0];
          if (boundary === undefined)
            throw new Error("Managed boundary resolution lost its selection");
          const resolvedInput = {
            ...parsed.data,
            managed_boundaries: boundary,
            native_observations: [...observations.value.records],
          };
          const result = await logToolExecution(
            options.logger,
            nativeVerificationContract.name,
            () =>
              Promise.resolve(executeManagedNativeBoundaries(resolvedInput)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(
              result,
              nativeVerificationContract,
            );
          const execution = result.value;
          const recordedSources = recordEvidenceSources(
            options.recordEvidence,
            [
              ...boundaries.value.sources,
              ...observations.value.sources,
              ...execution.sourceEvidence,
            ],
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(
              recordedSources,
              nativeVerificationContract,
            );
          const unknownInput = execution.hasUnknowns
            ? workflowUnknownInput(execution.evidence.evidence_id, {
                question:
                  "Which managed/native boundaries remain unresolved or contradicted by the supplied native Evidence?",
                severity: "medium",
                domain: "managed-native-verification",
                required_authority: "shipped-artifact",
                required_confidence: "observed",
                required_environment: null,
                recommended_probes: [
                  {
                    operation: "inspect_managed_native_boundaries",
                    rationale:
                      "Review the inspection Evidence coverage and limit diagnostics; this operation has no page override, so unresolved declarations must remain unknown.",
                  },
                  {
                    operation: "analyze_function",
                    rationale:
                      "Analyze the provider-resolved native function candidate for the declared export.",
                  },
                ],
                relationships: [],
              })
            : undefined;
          const output =
            unknownInput === undefined
              ? options.recordEvidence?.(execution.evidence)
              : unknownInput.ok
                ? options.recordEvidenceWithUnknown?.(
                    execution.evidence,
                    unknownInput.value,
                  )
                : unknownInput;
          return server.delivery.toEvidenceToolResult(
            execution.evidence,
            nativeVerificationContract,
            output,
          );
        },
      ),
  );
};
