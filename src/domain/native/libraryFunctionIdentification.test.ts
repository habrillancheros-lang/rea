import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  identifyLibraryFunctions,
  MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS,
} from "./libraryFunctionIdentification.js";

const signature = (
  id: string,
  pattern: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  library: "libc",
  pattern,
  ...overrides,
});

describe("identifyLibraryFunctions", () => {
  it("matches exact signatures at the function start", () => {
    expect(
      identifyLibraryFunctions(
        [{ function_id: "f1", bytes: [0x55, 0x48, 0x89, 0xe5] }],
        [signature("memcpy", "55 48 89 E5")],
      ),
    ).toEqual({
      identified: [
        {
          function_id: "f1",
          matches: [
            {
              signature_id: "memcpy",
              name: "memcpy",
              library: "libc",
              library_version: null,
              pattern_length: 4,
              wildcard_count: 0,
              score: 1,
              confidence: "exact",
            },
          ],
        },
      ],
      unknowns: [],
    });
  });

  it("matches wildcards and reports pattern confidence", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0x8b, 0xe5] }],
      [signature("memcpy", "55 48 ?? E5")],
    );
    expect(result.identified[0]?.matches[0]).toMatchObject({
      wildcard_count: 1,
      score: 0.75,
      confidence: "pattern",
    });
  });

  it("does not match a signature that is longer than the function", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55] }],
      [signature("short", "55 ?? ??")],
    );
    expect(result.identified[0]?.matches).toEqual([]);
  });

  it("matches wildcard signatures at the exact function length", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0xe5] }],
      [signature("exact-length", "55 ?? E5")],
    );
    expect(result.identified[0]?.matches[0]).toMatchObject({
      signature_id: "exact-length",
      pattern_length: 3,
      wildcard_count: 1,
      confidence: "pattern",
    });
  });

  it("anchors patterns at offset zero", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, 0x55, 0x48, 0x89, 0xe5] }],
      [signature("memcpy", "55 48 89 E5")],
    );
    expect(result.identified[0]?.matches).toEqual([]);
  });

  it("keeps all equally valid signatures with deterministic ranking", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0x89, 0xe5] }],
      [
        signature("short", "55 48 ??"),
        signature("exact-z", "55 48 89 E5"),
        signature("exact-a", "55 48 89 E5"),
      ],
    );
    expect(
      result.identified[0]?.matches.map((match) => match.signature_id),
    ).toEqual(["exact-a", "exact-z", "short"]);
  });

  it("preserves optional library versions", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90] }],
      [signature("nop", "90", { library_version: "2.39" })],
    );
    expect(result.identified[0]?.matches[0]?.library_version).toBe("2.39");
  });
});

describe("identifyLibraryFunctions resource limits", () => {
  it("reports functions beyond the function budget as unknown", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: [0x90] },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("enforces the function budget before validating skipped bytes", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: ["not a byte"] },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("does not read bytes for functions skipped by the function budget", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        {
          function_id: "f2",
          get bytes(): never {
            throw new Error("skipped bytes were read");
          },
        },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("reports oversized function bytes as unknown", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, 0x90] }],
      [signature("nop", "90")],
      { max_function_bytes: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f1", reason: "function_bytes_budget_exceeded" },
    ]);
  });

  it("enforces the byte budget before validating oversized bytes", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, "not a byte"] }],
      [signature("nop", "90")],
      { max_function_bytes: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f1", reason: "function_bytes_budget_exceeded" },
    ]);
  });

  it("accepts functions at the exact count and byte limits", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: [0x90] },
      ],
      [signature("nop", "90")],
      { max_functions: 2, max_function_bytes: 1 },
    );
    expect(result.identified.map((input) => input.function_id)).toEqual([
      "f1",
      "f2",
    ]);
    expect(result.unknowns).toEqual([]);
  });

  it("enforces the signature budget before validating signatures", () => {
    expect(() =>
      identifyLibraryFunctions(
        [],
        [signature("first", "90"), { invalid: true }],
        { max_signatures: 1 },
      ),
    ).toThrow(/Signature set exceeds the maximum of 1 signatures/u);
  });

  it("rejects duplicate signature ids", () => {
    expect(() =>
      identifyLibraryFunctions(
        [],
        [signature("duplicate", "90"), signature("duplicate", "91")],
      ),
    ).toThrow(z.ZodError);
  });

  it("rejects all-wildcard signatures", () => {
    expect(() =>
      identifyLibraryFunctions([], [signature("wild", "?? ??")]),
    ).toThrow(z.ZodError);
  });

  it("rejects patterns over the token cap", () => {
    expect(() =>
      identifyLibraryFunctions(
        [],
        [
          signature(
            "long",
            "90 ".repeat(MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS + 1),
          ),
        ],
      ),
    ).toThrow(z.ZodError);
  });

  it("accepts the token limit with mixed whitespace and rejects oversized tokens", () => {
    const pattern = Array.from(
      { length: MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS },
      () => "90",
    ).join(" \n\t");
    const result = identifyLibraryFunctions(
      [
        {
          function_id: "f",
          bytes: Array(MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS).fill(0x90),
        },
      ],
      [signature("bounded", pattern)],
    );
    expect(result.identified[0]?.matches[0]?.pattern_length).toBe(
      MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS,
    );
    expect(() =>
      identifyLibraryFunctions([], [signature("bad", "9".repeat(100_000))]),
    ).toThrow(z.ZodError);
  });
});
