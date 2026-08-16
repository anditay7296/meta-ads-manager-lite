import { db, schema } from "@/lib/db/client";
import { decryptToken } from "@/lib/crypto/tokens";
import { MetaClient } from "@/lib/meta/client";
import { and, eq, isNull, sql } from "drizzle-orm";

export type MetaClientHandle = {
  client: MetaClient;
  connectionId: string;
};

/**
 * Loads the active (non-revoked) Meta connection for an org, decrypts the
 * stored long-lived token, and returns a ready-to-use MetaClient. Returns
 * null if no connection exists.
 *
 * If multiple connections exist for the same org (different Meta users
 * connected), the most recent non-revoked one wins.
 *
 * @deprecated For most call sites, prefer the resource-aware helpers
 * (`getMetaClientForAdAccount`, `getMetaClientForMetaAccountId`,
 * `getMetaClientForPage`). Those look up the connection that actually owns
 * the resource, which is correct when the org has multiple connections
 * (e.g. different staff manage different projects). Keep this for legitimately
 * org-wide use cases (OAuth refresh of all connections, bootstrap checks).
 */
export async function getMetaClientForOrg(
  orgId: string,
): Promise<MetaClientHandle | null> {
  const rows = await db
    .select({
      id: schema.metaConnections.id,
      tokenEncrypted: schema.metaConnections.tokenEncrypted,
    })
    .from(schema.metaConnections)
    .where(
      and(
        eq(schema.metaConnections.orgId, orgId),
        isNull(schema.metaConnections.revokedAt),
      ),
    )
    .orderBy(sql`${schema.metaConnections.createdAt} desc`)
    .limit(1);
  if (rows.length === 0) return null;
  const token = decryptToken(rows[0].tokenEncrypted);
  const connectionId = rows[0].id;
  return {
    client: new MetaClient({
      accessToken: token,
      orgId,
      connectionId,
      audit: makeAuditWriter({ orgId, connectionId }),
    }),
    connectionId,
  };
}

/**
 * Returns the decrypted long-lived token for the org's most recent
 * non-revoked Meta connection, or null when none exists. For server-side
 * use only (e.g. the ad-library thumbnail route, which must append the
 * token to Meta's snapshot-page URL without ever sending it to the
 * browser). Never log or return this value to the client.
 */
export async function getOrgMetaAccessToken(
  orgId: string,
): Promise<string | null> {
  const rows = await db
    .select({ tokenEncrypted: schema.metaConnections.tokenEncrypted })
    .from(schema.metaConnections)
    .where(
      and(
        eq(schema.metaConnections.orgId, orgId),
        isNull(schema.metaConnections.revokedAt),
      ),
    )
    .orderBy(sql`${schema.metaConnections.createdAt} desc`)
    .limit(1);
  if (rows.length === 0) return null;
  return decryptToken(rows[0].tokenEncrypted);
}

type AuditEntry = {
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  requestBody?: unknown;
  responseExcerpt?: unknown;
  error?: string;
  calledBy?: string;
};

// Each batched INSERT carries ~10 cols × N rows of parameters. Cap at 500
// rows to stay well under Postgres' 65 534 wire-protocol parameter limit.
const AUDIT_FLUSH_CHUNK = 500;

/**
 * Audit log writer for `meta_api_calls`. Two modes:
 *
 *   - **Immediate (default):** every `record()` does one INSERT. Right for
 *     one-off operations (e.g., a Server Action pausing a single ad), where
 *     the audit trail outlives the function lifetime only via the DB write.
 *   - **Batched:** between `beginBatch()` and `flush()`, records accumulate
 *     in memory and land in a single bulk INSERT on `flush()`. Right for
 *     long-running multi-call operations like `syncProject`, which can fire
 *     200-400 Meta API calls per run; per-call INSERTs were one of the main
 *     drivers of the May 10-11 Vercel CPU spike.
 *
 * MetaClient catches errors from `record()` to keep audit failures from
 * breaking the request flow.
 */
export function makeAuditWriter(opts: { orgId: string; connectionId: string }): {
  record: (entry: AuditEntry) => Promise<void>;
  beginBatch: () => void;
  flush: () => Promise<void>;
} {
  let batched = false;
  let buffer: AuditEntry[] = [];

  const insertRows = async (rows: AuditEntry[]): Promise<void> => {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += AUDIT_FLUSH_CHUNK) {
      const chunk = rows.slice(i, i + AUDIT_FLUSH_CHUNK);
      await db.insert(schema.metaApiCalls).values(
        chunk.map((entry) => ({
          orgId: opts.orgId,
          connectionId: opts.connectionId,
          method: entry.method,
          path: entry.path,
          status: entry.status,
          durationMs: entry.durationMs,
          requestBody: (entry.requestBody as object | null) ?? null,
          responseExcerpt: (entry.responseExcerpt as object | null) ?? null,
          error: entry.error ?? null,
          calledBy: entry.calledBy ?? null,
        })),
      );
    }
  };

  return {
    async record(entry) {
      if (batched) {
        buffer.push(entry);
        return;
      }
      await insertRows([entry]);
    },
    beginBatch() {
      batched = true;
    },
    async flush() {
      batched = false;
      if (buffer.length === 0) return;
      const toFlush = buffer;
      buffer = [];
      await insertRows(toFlush);
    },
  };
}

/**
 * Returns the MetaClient for the connection that owns the given ad account
 * (by ad_accounts.id UUID). Filters out revoked connections. Returns null if
 * the account isn't found, or its connection has been revoked.
 *
 * This is the right helper for any operation scoped to a specific ad account
 * (create/pause/resume/sync) so requests go through the token whose owner
 * actually has access to the account in Meta.
 */
export async function getMetaClientForAdAccount(
  orgId: string,
  adAccountId: string,
): Promise<MetaClientHandle | null> {
  const rows = await db
    .select({
      id: schema.metaConnections.id,
      tokenEncrypted: schema.metaConnections.tokenEncrypted,
    })
    .from(schema.adAccounts)
    .innerJoin(
      schema.metaConnections,
      eq(schema.metaConnections.id, schema.adAccounts.connectionId),
    )
    .where(
      and(
        eq(schema.adAccounts.orgId, orgId),
        eq(schema.adAccounts.id, adAccountId),
        isNull(schema.metaConnections.revokedAt),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const token = decryptToken(rows[0].tokenEncrypted);
  return {
    client: new MetaClient({
      accessToken: token,
      orgId,
      connectionId: rows[0].id,
    }),
    connectionId: rows[0].id,
  };
}

/**
 * Same as `getMetaClientForAdAccount` but keyed on Meta's account ID string
 * (e.g. `act_1217628437192234`). Convenient when the caller only has the
 * Meta-side identifier (e.g. data coming back from Meta API).
 */
export async function getMetaClientForMetaAccountId(
  orgId: string,
  metaAccountId: string,
): Promise<MetaClientHandle | null> {
  const rows = await db
    .select({
      id: schema.metaConnections.id,
      tokenEncrypted: schema.metaConnections.tokenEncrypted,
    })
    .from(schema.adAccounts)
    .innerJoin(
      schema.metaConnections,
      eq(schema.metaConnections.id, schema.adAccounts.connectionId),
    )
    .where(
      and(
        eq(schema.adAccounts.orgId, orgId),
        eq(schema.adAccounts.metaAccountId, metaAccountId),
        isNull(schema.metaConnections.revokedAt),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const token = decryptToken(rows[0].tokenEncrypted);
  return {
    client: new MetaClient({
      accessToken: token,
      orgId,
      connectionId: rows[0].id,
    }),
    connectionId: rows[0].id,
  };
}

/**
 * Returns the MetaClient for the connection that owns the given Facebook Page
 * (by pages.id UUID). Filters out revoked connections. Returns null if the
 * page row isn't found or its owning connection has been revoked.
 *
 * Posting flows (`lib/meta/posting.ts`) already use per-page tokens stored on
 * the page row itself, so they don't strictly need this. Use this when you
 * need to call MetaClient methods that aren't page-token-scoped (e.g.
 * insights, page-level Marketing API endpoints) on behalf of a specific Page.
 */
export async function getMetaClientForPage(
  orgId: string,
  pageId: string,
): Promise<MetaClientHandle | null> {
  const rows = await db
    .select({
      id: schema.metaConnections.id,
      tokenEncrypted: schema.metaConnections.tokenEncrypted,
    })
    .from(schema.pages)
    .innerJoin(
      schema.metaConnections,
      eq(schema.metaConnections.id, schema.pages.connectionId),
    )
    .where(
      and(
        eq(schema.pages.orgId, orgId),
        eq(schema.pages.id, pageId),
        isNull(schema.metaConnections.revokedAt),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const token = decryptToken(rows[0].tokenEncrypted);
  return {
    client: new MetaClient({
      accessToken: token,
      orgId,
      connectionId: rows[0].id,
    }),
    connectionId: rows[0].id,
  };
}

/**
 * Returns all non-revoked MetaClients for an org, keyed by connection ID.
 * Useful for org-wide refresh paths that need to iterate each connection
 * and let each token discover only the resources it can see (e.g.
 * `refreshMetaInventoryAction`). Each handle includes the metaUserName so
 * callers can render a per-user breakdown.
 */
export async function getAllMetaClientsForOrg(
  orgId: string,
): Promise<Array<MetaClientHandle & { metaUserName: string | null }>> {
  const rows = await db
    .select({
      id: schema.metaConnections.id,
      tokenEncrypted: schema.metaConnections.tokenEncrypted,
      metaUserName: schema.metaConnections.metaUserName,
    })
    .from(schema.metaConnections)
    .where(
      and(
        eq(schema.metaConnections.orgId, orgId),
        isNull(schema.metaConnections.revokedAt),
      ),
    )
    .orderBy(sql`${schema.metaConnections.createdAt} asc`);
  return rows.map((row) => ({
    client: new MetaClient({
      accessToken: decryptToken(row.tokenEncrypted),
      orgId,
      connectionId: row.id,
    }),
    connectionId: row.id,
    metaUserName: row.metaUserName,
  }));
}
