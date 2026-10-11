import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode } from "../src/normalize/ir.js";
import type { MotionCapture } from "../src/capture/motion.js";
import { buildMotionSpec } from "../src/generate/motion.js";

// Issue #65 — a closed accordion panel was also replayed as a `visibility:hidden` scroll reveal, which
// hides its content but keeps its full OPEN height. Reveals on or inside an accordion region must be
// left to the accordion runtime.

function node(id: string, cap: string | null, children: IRNode[] = []): IRNode {
  return {
    id, tag: "div",
    attrs: cap !== null ? { "data-cid-cap": cap } : {},
    visibleByVp: {}, bboxByVp: {}, computedByVp: {},
    children,
  } as unknown as IRNode;
}
const ir = (root: IRNode): IR => ({ doc: { canonicalViewport: 1280 } as unknown as IR["doc"], root });
const reveal = (cap: string) => ({ cap, opacity: "1", transform: "none", transition: "", visibility: "hidden" as const });
const motion = (caps: string[]): MotionCapture =>
  ({ waapi: [], rotators: [], reveals: caps.map(reveal), marquees: [] }) as unknown as MotionCapture;

describe("buildMotionSpec accordion-owned reveal guard (issue #65)", () => {
  // n0 ─┬─ n1 (FAQ row) ── n2 (answer panel = accordion region) ── n3 (answer text)
  //     └─ n4 (unrelated hero block)
  const tree = () => ir(node("n0", null, [
    node("n1", "c1", [node("n2", "c2", [node("n3", "c3")])]),
    node("n4", "c4"),
  ]));

  it("drops a reveal on the accordion region itself", () => {
    const spec = buildMotionSpec(tree(), motion(["c2"]), undefined, ["n2"]);
    assert.equal(spec.reveals.length, 0);
  });

  it("drops a reveal on a descendant of the accordion region", () => {
    const spec = buildMotionSpec(tree(), motion(["c3"]), undefined, ["n2"]);
    assert.equal(spec.reveals.length, 0);
  });

  it("keeps reveals outside accordion regions (including the row that holds the region)", () => {
    const spec = buildMotionSpec(tree(), motion(["c1", "c4"]), undefined, ["n2"]);
    assert.deepEqual(spec.reveals.map((r) => r.cid).sort(), ["n1", "n4"]);
  });

  it("is a no-op without accordion regions (existing callers unchanged)", () => {
    const spec = buildMotionSpec(tree(), motion(["c2", "c3", "c4"]));
    assert.equal(spec.reveals.length, 3);
  });
});
