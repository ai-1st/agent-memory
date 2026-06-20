/**
 * Regression coverage for the tolerant extraction schemas.
 *
 * Context: in benchmarking, the live `generateObject` extraction intermittently
 * threw "No object generated: response did not match schema" against Claude Opus
 * 4.8's output and silently fell back to the rule extractor. The schemas were
 * over-strict for the variance Opus emits (pluralised/cased type, percentage or
 * string confidence, string mutable, omitted snippet/entities, object entities,
 * extra fields). These tests assert the schema now NORMALISES those shapes
 * instead of throwing — exercising the exact validation `generateObject` runs on
 * the model response — and that the inner JSON-schema guidance is still strict.
 */

import { describe, expect, it } from "vitest";
import { extractCandidatesViaMock } from "./helpers_extract";

describe("extraction schema is tolerant of Opus output variance", () => {
  it("normalises the previously-failing shape instead of throwing", async () => {
    // A realistic Opus payload that the OLD strict schema rejected:
    //  - type "Facts" (cased + pluralised)
    //  - confidence 92 (percentage, not 0..1)
    //  - mutable "true" (string, not boolean)
    //  - entities as objects + missing on the last entry
    //  - snippet omitted on entries 1 & 3
    //  - an extra `source` field the model invented
    const raw = {
      memories: [
        {
          type: "Facts",
          key: "employment",
          value: "Notion as a PM",
          confidence: 92,
          mutable: "true",
          entities: [{ name: "Notion" }, "PM"],
          source: "I just joined Notion as a PM",
        },
        {
          type: "preference",
          key: "diet",
          value: "vegetarian",
          confidence: "0.8",
          mutable: false,
          snippet: "I'm vegetarian",
          entities: ["vegetarian"],
        },
        {
          // alias type + omitted confidence/mutable/snippet/entities entirely
          type: "belief",
          key: "opinion:typescript",
          value: "loves TypeScript",
        },
      ],
    };

    const mems = await extractCandidatesViaMock(raw);
    expect(mems).toHaveLength(3);

    const [a, b, c] = mems;
    // 1) cased+pluralised "Facts" -> "fact"; 92 -> 0.92; "true" -> true; objects -> tokens
    expect(a.type).toBe("fact");
    expect(a.confidence).toBeCloseTo(0.92);
    expect(a.mutable).toBe(true);
    expect(a.entities).toEqual(["notion", "pm"]);
    expect(a.snippet).toBeTruthy(); // backfilled from value when omitted
    // 2) string confidence coerces
    expect(b.confidence).toBeCloseTo(0.8);
    expect(b.mutable).toBe(false);
    // 3) alias type maps to enum; sensible defaults applied
    expect(c.type).toBe("opinion");
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
    expect(typeof c.mutable).toBe("boolean");
    expect(c.snippet).toBe("loves TypeScript");
    expect(c.entities).toEqual([]);

    // Every normalised value must satisfy the strict canonical contract.
    for (const m of mems) {
      expect(["fact", "preference", "opinion", "event"]).toContain(m.type);
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
      expect(typeof m.key).toBe("string");
      expect(m.key.length).toBeGreaterThan(0);
      expect(Array.isArray(m.entities)).toBe(true);
    }
  });

  it("accepts a bare array and a {memories:[]} empty result", async () => {
    const arr = await extractCandidatesViaMock([
      { type: "event", key: "trip", value: "went to Japan" },
    ]);
    expect(arr).toHaveLength(1);
    expect(arr[0].type).toBe("event");

    const empty = await extractCandidatesViaMock({ memories: [] });
    expect(empty).toEqual([]);
  });

  it("emits a STRICT inner JSON schema as model guidance (not an empty object)", async () => {
    // The model must still receive the full object schema (enum, required fields)
    // even though validation normalises — otherwise Opus has nothing to conform to.
    const { default: zodToJsonSchema } = await import("zod-to-json-schema");
    const { extractionResultSchema } = await import("../src/extraction/schemas");
    const js = zodToJsonSchema(extractionResultSchema, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as Record<string, any>;
    const item = js.properties.memories.items;
    expect(item.type).toBe("object");
    expect(item.properties.type.enum).toEqual(["fact", "preference", "opinion", "event"]);
    expect(item.required).toEqual(
      expect.arrayContaining(["type", "key", "value", "confidence", "mutable"]),
    );
  });

  it("repairJsonText salvages fenced / prefixed JSON (a JSONParseError edge)", async () => {
    const { repairJsonText } = await import("../src/llm/client");
    const obj = '{"memories":[{"type":"fact","key":"name","value":"Sam"}]}';
    const noop = { error: {} as any };
    // Fenced ```json block -> inner JSON returned.
    const fenced = await repairJsonText({ text: `\`\`\`json\n${obj}\n\`\`\``, ...noop });
    expect(fenced && JSON.parse(fenced).memories[0].value).toBe("Sam");
    // Prose preamble before the object -> object span returned.
    const prefixed = await repairJsonText({ text: `Sure, here you go: ${obj}`, ...noop });
    expect(prefixed && JSON.parse(prefixed).memories).toHaveLength(1);
    // Nothing salvageable -> null (SDK keeps its original error).
    expect(await repairJsonText({ text: "no json here at all", ...noop })).toBeNull();
  });

  it("normalises reconcile decisions (case, target_id 'null' string)", async () => {
    const { reconcileDecisionSchema } = await import("../src/extraction/schemas");
    const a = reconcileDecisionSchema.parse({
      decision: "supersede",
      target_id: "mem-1",
      reason: "job change",
    });
    expect(a.decision).toBe("SUPERSEDE");
    expect(a.target_id).toBe("mem-1");

    const b = reconcileDecisionSchema.parse({ decision: "ADD", target_id: "null" });
    expect(b.decision).toBe("ADD");
    expect(b.target_id).toBeNull();
    expect(b.reason).toBeTruthy();
  });
});
