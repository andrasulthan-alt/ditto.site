import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, repo, type Db } from "../src/index.js";
import { acquireTestPostgres, hasTestPostgres, type EphemeralPg } from "@cloner/test-utils";

// Issue #37 — signup token reuse grace window (DB queries).
describe("signup token reclaim / link / revoke", { skip: hasTestPostgres() ? false : "no test Postgres" }, () => {
  let pg: EphemeralPg;
  let db: Db;
  let pool: { end: () => Promise<void> };

  before(async () => {
    pg = (await acquireTestPostgres())!;
    await runMigrations(pg.url);
    const h = createDb(pg.url);
    db = h.db;
    pool = h.pool;
  });
  after(async () => {
    await pool?.end().catch(() => {});
    await pg?.stop().catch(() => {});
  });

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

  it("reclaims a token consumed inside the window and links/revokes its key", async () => {
    const tok = await repo.createSignupToken(db, { email: "a@example.com", tokenHash: "h-reclaim", expiresAt: inMinutes(30) });
    assert.equal(await repo.reclaimSignupToken(db, "h-reclaim", minutesAgo(15)), undefined, "an unused token can't be reclaimed");

    const consumed = await repo.consumeSignupToken(db, "h-reclaim");
    assert.equal(consumed?.id, tok.id);
    assert.equal(await repo.consumeSignupToken(db, "h-reclaim"), undefined, "consume stays single-use");

    const key = await repo.createApiKey(db, { keyHash: "k-1", label: "a@example.com" });
    await repo.linkSignupTokenKey(db, tok.id, key.id);

    const again = await repo.reclaimSignupToken(db, "h-reclaim", minutesAgo(15));
    assert.equal(again?.id, tok.id);
    assert.equal(again?.apiKeyId, key.id, "the reclaimed token reports the key it minted");

    await repo.revokeApiKey(db, key.id);
    const revoked = await repo.getApiKeyByHash(db, "k-1");
    assert.ok(revoked?.revokedAt, "key revoked");
    const firstRevokedAt = revoked!.revokedAt!.getTime();
    await repo.revokeApiKey(db, key.id);
    assert.equal((await repo.getApiKeyByHash(db, "k-1"))?.revokedAt?.getTime(), firstRevokedAt, "revoke is idempotent");
  });

  it("does not reclaim once the grace window has passed", async () => {
    await repo.createSignupToken(db, { email: "b@example.com", tokenHash: "h-late", expiresAt: inMinutes(30) });
    await repo.consumeSignupToken(db, "h-late");
    // Window starts in the future relative to consumedAt → consumed "too long ago".
    assert.equal(await repo.reclaimSignupToken(db, "h-late", inMinutes(1)), undefined);
  });

  it("does not reclaim an expired token even inside the window", async () => {
    await repo.createSignupToken(db, { email: "c@example.com", tokenHash: "h-expired", expiresAt: inMinutes(30) });
    await repo.consumeSignupToken(db, "h-expired");
    await db.execute(sql`update signup_tokens set expires_at = now() - interval '1 minute' where token_hash = 'h-expired'`);
    assert.equal(await repo.reclaimSignupToken(db, "h-expired", minutesAgo(15)), undefined);
  });

  it("clears the link when the key row is deleted (on delete set null)", async () => {
    const tok = await repo.createSignupToken(db, { email: "d@example.com", tokenHash: "h-del", expiresAt: inMinutes(30) });
    await repo.consumeSignupToken(db, "h-del");
    const key = await repo.createApiKey(db, { keyHash: "k-del", label: "d@example.com" });
    await repo.linkSignupTokenKey(db, tok.id, key.id);
    await db.execute(sql`delete from api_keys where key_hash = 'k-del'`);
    const again = await repo.reclaimSignupToken(db, "h-del", minutesAgo(15));
    assert.equal(again?.apiKeyId, null);
  });
});
