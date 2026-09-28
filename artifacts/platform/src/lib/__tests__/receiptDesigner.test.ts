import { describe, expect, it } from "vitest";
import {
  defaultBlocks,
  fromLayout,
  makeBlock,
  moveBlock,
  sizeFromFont,
  textProblem,
  toLayout,
  SIZE_FONT,
} from "../receiptDesigner";

describe("receipt designer serialization", () => {
  it("round-trips blocks through the server layout", () => {
    const blocks = defaultBlocks();
    const layout = toLayout(blocks);
    expect(fromLayout(layout)).toEqual(blocks);
  });

  it("emits only keys the server schema knows", () => {
    const allowed: Record<string, string[]> = {
      data: ["type", "id", "enabled", "align", "bold", "fontSize", "spacingBefore", "spacingAfter", "field", "label", "showOption", "showSku", "showUnitPrice", "showItemNotes"],
      customText: ["type", "id", "enabled", "align", "bold", "fontSize", "spacingBefore", "spacingAfter", "text"],
      separator: ["type", "id", "enabled", "style", "spacingBefore", "spacingAfter"],
    };
    const taken = new Set<string>();
    const blocks = [makeBlock("data", taken, "items"), makeBlock("text", taken), makeBlock("separator", taken)];
    if (blocks[0]!.kind === "data") blocks[0]!.itemOptions = { showSku: true, showUnitPrice: false };
    for (const block of toLayout(blocks)) {
      for (const key of Object.keys(block)) expect(allowed[String(block.type)]).toContain(key);
    }
  });

  it("maps sizes and spacing to the server's units", () => {
    expect(SIZE_FONT).toEqual({ normal: 12, tall: 20, large: 36 });
    expect([sizeFromFont(12), sizeFromFont(20), sizeFromFont(36), sizeFromFont(17), sizeFromFont(32)]).toEqual(["normal", "tall", "large", "tall", "large"]);
    const [block] = toLayout([{ ...makeBlock("separator", new Set()), spaceBefore: 2, spaceAfter: 4 }]);
    expect(block).toMatchObject({ spacingBefore: 24, spacingAfter: 48 });
  });

  it("only sends item options on the items field and drops empty labels", () => {
    const taken = new Set<string>();
    const total = makeBlock("data", taken, "total");
    if (total.kind === "data") total.itemOptions = { showSku: true };
    expect(toLayout([total])[0]).not.toHaveProperty("showSku");
    expect(toLayout([total])[0]).not.toHaveProperty("label");
  });

  it("drops unknown block types and malformed entries when loading", () => {
    expect(fromLayout([{ type: "html", id: "x" }, null, { type: "data" }, { type: "separator", id: "s", style: "weird" }]))
      .toEqual([{ kind: "separator", id: "s", enabled: true, spaceBefore: 0, spaceAfter: 0, style: "dashed" }]);
    expect(fromLayout("not a layout")).toEqual([]);
  });

  it("flags text the server would reject", () => {
    expect(textProblem("Thanks!", 500)).toBeNull();
    expect(textProblem("x".repeat(501), 500)).toContain("500");
    expect(textProblem("bad" + String.fromCharCode(27) + "@", 500)).toContain("control");
    expect(textProblem("bidi" + String.fromCharCode(0x202e), 500)).toContain("control");
  });

  it("reorders blocks within bounds", () => {
    expect(moveBlock(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveBlock(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("generates unique block ids", () => {
    const taken = new Set<string>();
    const ids = Array.from({ length: 50 }, () => { const block = makeBlock("data", taken); taken.add(block.id); return block.id; });
    expect(new Set(ids).size).toBe(50);
    expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
  });
});
