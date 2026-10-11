import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryDecision, terminalReason } from "../src/retryPolicy.js";

// Issue #22 — deterministic capture failures must not be re-run by pg-boss.
describe("worker retry policy", () => {
  it("treats a collectPage timeout as terminal", () => {
    assert.equal(retryDecision(new Error("collectPage timeout vp1280")), "terminal");
    assert.equal(terminalReason(new Error("collectPage timeout vp375")), "collect_page_timeout");
  });

  it("treats a bot/auth wall or HTTP 403/429 block as terminal", () => {
    const e = new Error("target site is blocking automated access at https://x.test/ (HTTP 403, bot-protection page detected) — refusing to clone");
    assert.equal(retryDecision(e), "terminal");
    assert.equal(terminalReason(e), "blocked_access");
  });

  it("treats a robots.txt opt-out as terminal", () => {
    const e = new Error("robots.txt at https://x.test disallows crawling / — this site opts out of automated access, refusing to clone it");
    assert.equal(terminalReason(e), "robots_disallow");
  });

  it("treats a missing reused entry capture as terminal", () => {
    assert.equal(terminalReason(new Error("requested entry capture is unavailable for job job_1")), "entry_capture_unavailable");
  });

  it("keeps transient infrastructure failures retryable", () => {
    for (const msg of [
      "browserType.launch: spawn EAGAIN",
      "Target page, context or browser has been closed",
      "net::ERR_CONNECTION_RESET",
      "Connection terminated unexpectedly",
      "S3: 503 Slow Down",
      "navigation failed for https://x.test within 45s: Timeout 30000ms exceeded",
    ]) {
      assert.equal(retryDecision(new Error(msg)), "retry", msg);
    }
  });

  it("does not match a loose mention of a terminal keyword", () => {
    assert.equal(retryDecision(new Error("upstream timeout while uploading collectPage results")), "retry");
  });

  it("accepts non-Error throwables", () => {
    assert.equal(retryDecision("collectPage timeout vp768"), "terminal");
    assert.equal(retryDecision({ message: "collectPage timeout vp768" }), "terminal");
    assert.equal(retryDecision(undefined), "retry");
  });
});
