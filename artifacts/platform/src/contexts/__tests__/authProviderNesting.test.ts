import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("authentication provider nesting", () => {
  it("mounts every cart provider inside Clerk before it reads auth identity", () => {
    const source = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const cartAncestors: string[][] = [];

    function visit(node: ts.Node, ancestors: string[]) {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(file);
        if (tag === "CartProvider") cartAncestors.push(ancestors);
        ts.forEachChild(node, child => visit(child, [...ancestors, tag]));
      } else {
        ts.forEachChild(node, child => visit(child, ancestors));
      }
    }

    visit(file, []);
    expect(cartAncestors).toHaveLength(1);
    expect(cartAncestors[0]).toContain("ClerkProvider");
  });
});
