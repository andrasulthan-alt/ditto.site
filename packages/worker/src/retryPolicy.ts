/**
 * Queue retry policy for clone jobs (issue #22).
 *
 * pg-boss retries every handler failure (`retryLimit: 2` in @cloner/db's enqueueClone). That is
 * right for transient infrastructure errors — a crashed browser, a dropped DB connection, a storage
 * hiccup — but wrong for DETERMINISTIC capture failures: a bot-hostile or pathologically heavy site
 * that burned the full `collectPage` timeout will burn it again on an identical retry, holding a
 * worker slot for the whole window each time and roughly tripling the cost of a job that was always
 * going to fail.
 *
 * `processCloneJob` already marks the job `failed` (with the error) before rethrowing, so for a
 * terminal failure the worker can simply swallow the error: pg-boss records the attempt as complete
 * and does not retry, while the API still reports the job as failed with its real reason.
 *
 * Pure string classification, so it unit-tests without a browser or a database.
 */

export type RetryDecision = "retry" | "terminal";

/** Error signatures that an identical retry cannot change. Each matches a message thrown verbatim
 *  by the compiler or the worker; keep them anchored to those sources so an unrelated error that
 *  merely mentions a word like "timeout" is never treated as terminal. */
const TERMINAL_SIGNATURES: ReadonlyArray<{ reason: string; re: RegExp }> = [
  // compiler/src/capture/capture.ts — the bounded in-page DOM walk exceeded its budget.
  { reason: "collect_page_timeout", re: /\bcollectPage timeout vp\d+/ },
  // compiler/src/capture/capture.ts blockedAccessError — HTTP 403/429 or a bot/auth wall.
  { reason: "blocked_access", re: /target site is blocking automated access/ },
  // compiler/src/crawl/robotsGuard.ts — the site opts out of automated access.
  { reason: "robots_disallow", re: /robots\.txt at \S+ disallows crawling/ },
  // packages/worker/src/processJob.ts — the referenced prior capture does not exist.
  { reason: "entry_capture_unavailable", re: /requested entry capture is unavailable for job/ },
];

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const m = (error as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : String(error ?? "");
}

/** The terminal reason for a failure, or null when the failure is worth a queue retry. */
export function terminalReason(error: unknown): string | null {
  const msg = messageOf(error);
  for (const { reason, re } of TERMINAL_SIGNATURES) if (re.test(msg)) return reason;
  return null;
}

export function retryDecision(error: unknown): RetryDecision {
  return terminalReason(error) ? "terminal" : "retry";
}
