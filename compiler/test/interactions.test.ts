import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { captureInteractions, tagElements, diffStyle } from "../src/capture/interactions.js";

describe("diffStyle", () => {
  it("returns only the changed keys, with the b-side value", () => {
    const a = { color: "rgb(0, 0, 0)", opacity: "1", transform: "none" };
    const b = { color: "rgb(255, 0, 0)", opacity: "1", transform: "scale(1.1)" };
    assert.deepEqual(diffStyle(a, b), { color: "rgb(255, 0, 0)", transform: "scale(1.1)" });
  });
  it("is empty when nothing changed", () => {
    const a = { color: "rgb(0, 0, 0)", opacity: "1" };
    assert.deepEqual(diffStyle(a, { ...a }), {});
  });
  it("only reports keys present in b (b drives the comparison)", () => {
    // a resting style that carries an extra key does not fabricate a delta.
    assert.deepEqual(diffStyle({ color: "red", extra: "x" }, { color: "red" }), {});
  });
});

describe("captureInteractions hover capture (occlusion-immune)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  after(async () => {
    await browser.close();
  });

  const setup = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await tagElements(page);
  };

  it("captures an authored :hover state even when a transparent full-viewport overlay covers the target", async () => {
    // Exact regression for the empty-hover-capture bug: a modern builder stack parks a
    // transparent fixed layer over the whole page. page.hover moves the real cursor to the
    // link's centre, the point lands on the overlay, and `:hover` never reaches the link — so
    // pointer-based probing captured ZERO hover states. Forcing the pseudo-class fixes it.
    await setup(`
      <style>
        a.cta { color: rgb(0, 0, 0); background-color: rgb(255, 255, 255); }
        a.cta:hover { color: rgb(255, 0, 0); background-color: rgb(0, 0, 255); }
        .overlay { position: fixed; inset: 0; z-index: 9999; background: transparent; }
      </style>
      <a class="cta" href="#">Shop now</a>
      <div class="overlay"></div>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    const hoverCaps = Object.keys(cap.hover);
    assert.ok(hoverCaps.length >= 1, "at least one hover state is captured through the overlay");
    const delta = cap.hover[hoverCaps[0]!]!;
    assert.equal(delta.color, "rgb(255, 0, 0)", "hover color change is captured");
    assert.equal(delta.backgroundColor, "rgb(0, 0, 255)", "hover background change is captured");
  });

  it("captures :hover on a cursor:pointer element that is not a native interactive", async () => {
    await setup(`
      <style>
        .card { cursor: pointer; border: 2px solid rgb(1, 1, 1); }
        .card:hover { border-color: rgb(9, 9, 9); }
      </style>
      <div class="card" style="width:200px;height:120px;">Card</div>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    const found = Object.values(cap.hover).some((d) => d.borderTopColor === "rgb(9, 9, 9)");
    assert.ok(found, "a cursor:pointer card's authored :hover border change is captured");
  });

  it("records no hover delta for an element with no authored :hover (self-limiting)", async () => {
    await setup(`
      <a class="plain" href="#" style="color:rgb(0,0,0);">No hover</a>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    assert.equal(Object.keys(cap.hover).length, 0, "no authored hover -> empty hover map");
  });

  it("restores the resting state after probing (forced pseudo-state cleared)", async () => {
    await setup(`
      <style>
        a.cta { color: rgb(0, 0, 0); }
        a.cta:hover { color: rgb(255, 0, 0); }
      </style>
      <a class="cta" href="#">Link</a>`);
    await captureInteractions(page, { maxCandidates: 50 });
    const resting = await page.evaluate(() => getComputedStyle(document.querySelector("a.cta")!).color);
    assert.equal(resting, "rgb(0, 0, 0)", "the page is left in its resting (non-hover) state");
  });
});

// Issue #65 — only ONE FAQ row was recognized as an accordion, so the other closed panels kept their
// full open height in the clone. A recognized row must generalize to its same-structure siblings,
// and the driver must still reject a look-alike row that doesn't actually toggle.
describe("captureInteractions accordion sibling generalization (issue #65)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  after(async () => {
    await browser.close();
  });

  const faq = (rows: number, opts: { decoy?: boolean } = {}) => `
    <style>
      .faq-item { border-bottom: 1px solid #ddd; }
      .faq-q { display: block; width: 100%; text-align: left; padding: 16px; cursor: pointer; background: none; border: 0; font: 16px/24px sans-serif; }
      .faq-a { height: 0; overflow: hidden; visibility: hidden; }
      .faq-item.open .faq-a { height: auto; visibility: visible; }
      .faq-a p { margin: 0; padding: 0 16px 16px; font: 15px/22px sans-serif; }
    </style>
    <section class="faq">
      ${Array.from({ length: rows }, (_, i) => `
        <div class="faq-item">
          <button class="faq-q" aria-expanded="false"${i === 0 ? ' aria-controls="a0"' : ""}>Question ${i + 1}?</button>
          <div class="faq-a"${i === 0 ? ' id="a0"' : ""}><p>Answer ${i + 1}, long enough to occupy real height when the row is open.</p></div>
        </div>`).join("")}
      ${opts.decoy ? `
        <div class="faq-item decoy">
          <button class="faq-q" aria-expanded="false">Not a real question</button>
          <div class="faq-a"><p>This panel never opens.</p></div>
        </div>` : ""}
    </section>
    <script>
      for (const item of document.querySelectorAll(".faq-item:not(.decoy)")) {
        const btn = item.querySelector(".faq-q");
        btn.addEventListener("click", () => {
          const open = item.classList.toggle("open");
          btn.setAttribute("aria-expanded", String(open));
        });
      }
    </script>`;

  const setup = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await tagElements(page);
  };

  const accordionItems = async () => {
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    return cap.patterns.filter((p) => p.kind === "accordion").flatMap((p) => (p.kind === "accordion" ? p.items : []));
  };

  it("drives every same-structure FAQ row, not just the one with aria-controls", async () => {
    await setup(faq(6));
    const items = await accordionItems();
    assert.equal(items.length, 6, `all six rows should be accordion items, got ${items.length}`);
    for (const it of items) {
      assert.equal(it.expandedAtBase, false);
      assert.ok(/^0(px)?$/.test(String(it.regionHidden.height)), `closed panel keeps its collapsed height, got ${it.regionHidden.height}`);
      assert.match(String(it.regionHidden.overflow), /hidden|clip/);
    }
  });

  it("rejects a look-alike row whose panel never toggles", async () => {
    await setup(faq(4, { decoy: true }));
    const items = await accordionItems();
    assert.equal(items.length, 4, `the decoy row must be dropped by the driver, got ${items.length}`);
  });

  it("leaves a lone row alone when it has no look-alike siblings", async () => {
    await setup(faq(1));
    const items = await accordionItems();
    assert.equal(items.length, 1);
  });
});
