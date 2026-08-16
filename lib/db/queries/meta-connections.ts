import { db, schema } from "@/lib/db/client";
import { encryptToken } from "@/lib/crypto/tokens";
import { MetaClient } from "@/lib/meta/client";
import { and, eq, sql } from "drizzle-orm";

const { metaConnections, adAccounts, pages, igAccounts } = schema;

export type ConnectMetaInput = {
  orgId: string;
  connectedBy: string;
  metaUserId: string;
  metaUserName?: string | null;
  longLivedToken: string;
  scopes: string[];
  expiresInSeconds?: number;
};

export type ConnectMetaResult = {
  connectionId: string;
  adAccountCount: number;
  pageCount: number;
  igAccountCount: number;
};

/**
 * Idempotent connect-or-update. After upserting the meta_connections row,
 * pulls ad accounts + pages + IG accounts and caches them.
 */
export async function connectMeta(
  input: ConnectMetaInput,
): Promise<ConnectMetaResult> {
  const tokenEncrypted = encryptToken(input.longLivedToken);
  const tokenExpiresAt = input.expiresInSeconds
    ? new Date(Date.now() + input.expiresInSeconds * 1000)
    : null;

  const [conn] = await db
    .insert(metaConnections)
    .values({
      orgId: input.orgId,
      metaUserId: input.metaUserId,
      metaUserName: input.metaUserName ?? null,
      tokenEncrypted,
      tokenScopes: input.scopes,
      tokenExpiresAt,
      connectedBy: input.connectedBy,
    })
    .onConflictDoUpdate({
      target: [metaConnections.orgId, metaConnections.metaUserId],
      set: {
        metaUserName: input.metaUserName ?? null,
        tokenEncrypted,
        tokenScopes: input.scopes,
        tokenExpiresAt,
        connectedBy: input.connectedBy,
        revokedAt: null,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: metaConnections.id });

  const meta = new MetaClient({
    accessToken: input.longLivedToken,
    orgId: input.orgId,
    connectionId: conn.id,
  });

  const [accountsRes, pagesRes] = await Promise.all([
    meta.listAdAccounts(),
    meta.listPages(),
  ]);

  // Ad accounts
  if (accountsRes.data.length > 0) {
    const accountRows = accountsRes.data.map((a) => ({
      orgId: input.orgId,
      connectionId: conn.id,
      metaAccountId: a.id,
      name: a.name,
      currency: a.currency ?? null,
      timezone: a.timezone_name ?? null,
      businessId: a.business?.id ?? null,
      raw: a as unknown,
    }));
    await db
      .insert(adAccounts)
      .values(accountRows)
      .onConflictDoUpdate({
        target: [adAccounts.orgId, adAccounts.metaAccountId],
        set: {
          connectionId: conn.id,
          name: sql`excluded.name`,
          currency: sql`excluded.currency`,
          timezone: sql`excluded.timezone`,
          businessId: sql`excluded.business_id`,
          raw: sql`excluded.raw`,
          updatedAt: sql`now()`,
        },
      });
  }

  // Pages — also opportunistically fetch each page's IG business account.
  let igAccountCount = 0;
  if (pagesRes.data.length > 0) {
    for (const p of pagesRes.data) {
      const pageTokenEncrypted = p.access_token
        ? encryptToken(p.access_token)
        : null;
      const [pageRow] = await db
        .insert(pages)
        .values({
          orgId: input.orgId,
          connectionId: conn.id,
          metaPageId: p.id,
          name: p.name,
          pageAccessTokenEncrypted: pageTokenEncrypted,
          raw: p as unknown,
        })
        .onConflictDoUpdate({
          target: [pages.orgId, pages.metaPageId],
          set: {
            connectionId: conn.id,
            name: sql`excluded.name`,
            pageAccessTokenEncrypted: pageTokenEncrypted,
            raw: sql`excluded.raw`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: pages.id });

      try {
        const igRes = await meta.igUserForPage(p.id);
        const ig = igRes.instagram_business_account;
        if (ig?.id) {
          await db
            .insert(igAccounts)
            .values({
              orgId: input.orgId,
              pageId: pageRow.id,
              metaIgUserId: ig.id,
              username: ig.username ?? null,
              raw: ig as unknown,
            })
            .onConflictDoUpdate({
              target: [igAccounts.orgId, igAccounts.metaIgUserId],
              set: {
                pageId: pageRow.id,
                username: ig.username ?? null,
                raw: ig as unknown,
                updatedAt: sql`now()`,
              },
            });
          igAccountCount += 1;
        }
      } catch {
        // Some pages don't have a linked IG business account — non-fatal.
      }
    }
  }

  return {
    connectionId: conn.id,
    adAccountCount: accountsRes.data.length,
    pageCount: pagesRes.data.length,
    igAccountCount,
  };
}

export async function listMetaConnections(orgId: string) {
  return db
    .select({
      id: metaConnections.id,
      metaUserId: metaConnections.metaUserId,
      metaUserName: metaConnections.metaUserName,
      tokenScopes: metaConnections.tokenScopes,
      tokenExpiresAt: metaConnections.tokenExpiresAt,
      revokedAt: metaConnections.revokedAt,
      createdAt: metaConnections.createdAt,
    })
    .from(metaConnections)
    .where(
      and(
        eq(metaConnections.orgId, orgId),
        // Show only non-revoked connections; revocation is logical (Phase 6).
        sql`${metaConnections.revokedAt} is null`,
      ),
    );
}
