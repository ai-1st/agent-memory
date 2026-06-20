import { describe, expect, it } from "vitest";
import { mockEmbed } from "../src/llm";
import { rrf } from "../src/recall/fusion";
import { cosine } from "../src/util/text";

describe("reciprocal rank fusion", () => {
  it("rewards items ranked highly across multiple lists", () => {
    const fused = rrf([
      {
        name: "vec",
        ranked: [
          { id: "a", item: "a" },
          { id: "b", item: "b" },
        ],
      },
      {
        name: "lex",
        ranked: [
          { id: "b", item: "b" },
          { id: "a", item: "a" },
        ],
      },
    ]);
    // a and b both appear once near the top of each list -> close scores, both kept.
    const ids = fused.map((f) => f.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // an item appearing in only one list ranks below one appearing in both.
    const fused2 = rrf([
      {
        name: "vec",
        ranked: [
          { id: "x", item: "x" },
          { id: "y", item: "y" },
        ],
      },
      { name: "lex", ranked: [{ id: "x", item: "x" }] },
    ]);
    expect(fused2[0].id).toBe("x");
    expect(fused2[0].sources).toEqual(["vec", "lex"]);
  });
});

describe("mock embedding clusters related text", () => {
  it("similar sentences have higher cosine than unrelated ones", () => {
    const a = mockEmbed("the user lives in berlin");
    const b = mockEmbed("user location is berlin city");
    const c = mockEmbed("quantum chromodynamics lattice gauge theory");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});
