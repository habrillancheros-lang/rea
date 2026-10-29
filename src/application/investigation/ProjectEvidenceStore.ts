import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import canonicalize from "canonicalize";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { readImmutableEvidence } from "../../domain/evidenceValidation.js";
import { err, ok, type Result } from "../../domain/result.js";

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/u;

/** Project-local content-addressed Evidence storage under `.rea/evidence`. */
export class ProjectEvidenceStore {
  readonly #recordsDirectory: string;
  readonly #cache = new Map<string, Evidence>();
  readonly #scheduled = new Set<string>();
  readonly #pending = new Set<Promise<void>>();
  #writeChain: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(root: string) {
    this.#recordsDirectory = join(root, "records");
  }

  /** Schedule one authenticated record; repeated writes of an ID are coalesced. */
  persist(evidence: Evidence): void {
    const id = evidence.evidence_id;
    if (!EVIDENCE_ID.test(id) || this.#scheduled.has(id)) return;
    this.#scheduled.add(id);
    const write = this.#writeChain.then(() => this.#write(evidence));
    this.#writeChain = write.catch(() => undefined);
    const pending = write.catch((cause: unknown) => {
      this.#failure ??= cause;
    });
    this.#pending.add(pending);
    void pending.finally(() => {
      this.#pending.delete(pending);
    });
  }

  /** Return one stored record after authenticating its content and ID. */
  read(evidenceId: string): Evidence | undefined {
    if (!EVIDENCE_ID.test(evidenceId)) return undefined;
    const cached = this.#cache.get(evidenceId);
    if (cached !== undefined) return cached;
    const path = join(this.#recordsDirectory, `${evidenceId}.json`);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = readImmutableEvidence(
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (!parsed.ok || parsed.value.evidence_id !== evidenceId)
        return undefined;
      this.#cache.set(evidenceId, parsed.value);
      return parsed.value;
    } catch {
      return undefined;
    }
  }

  /** Report presence only when the stored record authenticates. */
  has(evidenceId: string): boolean {
    return this.read(evidenceId) !== undefined;
  }

  /** Wait for scheduled writes and report the first durable-write failure. */
  async flush(): Promise<Result<null, AnalysisError>> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
    if (this.#failure === undefined) return ok(null);
    const cause =
      this.#failure instanceof Error
        ? this.#failure
        : new Error(String(this.#failure));
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-evidence-store",
        "persist",
        `Project Evidence could not be written: ${cause.message}`,
        {
          cause,
          userMessage:
            "REA could not persist Evidence to the project store. Inspect the configured store directory permissions and available space before relying on cross-session reuse.",
        },
      ),
    );
  }

  async #write(evidence: Evidence): Promise<void> {
    await mkdir(this.#recordsDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.#recordsDirectory, `${evidence.evidence_id}.json`);
    const temporary = join(
      this.#recordsDirectory,
      `.${evidence.evidence_id}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        temporary,
        `${canonicalize(evidence) ?? JSON.stringify(evidence)}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, path);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  }
}
