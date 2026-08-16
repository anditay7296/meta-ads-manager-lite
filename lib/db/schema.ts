import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  customType,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Helpers ───────────────────────────────────────────────────────────────

const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" });
const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// ─── Enums ─────────────────────────────────────────────────────────────────

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"]);
export const projectRoleEnum = pgEnum("project_role", ["admin", "member"]);
export const inviteStatusEnum = pgEnum("invite_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const adObjectStatusEnum = pgEnum("ad_object_status", [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "ARCHIVED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "WITH_ISSUES",
  "IN_PROCESS",
]);
export const ruleTriggerEnum = pgEnum("rule_trigger", ["scheduled", "interval"]);
export const ruleActionTypeEnum = pgEnum("rule_action_type", [
  "pause",
  "notify",
  "adjust_budget",
]);
export const ruleScopeEnum = pgEnum("rule_scope", ["account", "campaign", "adset", "ad"]);
export const postPlatformEnum = pgEnum("post_platform", ["facebook", "instagram"]);
export const postStatusEnum = pgEnum("post_status", [
  "draft",
  "scheduled",
  "publishing",
  "published",
  "failed",
]);
export const postMediaKindEnum = pgEnum("post_media_kind", [
  "image",
  "video",
  "carousel",
  "reel",
  "story",
]);
export const agentMessageRoleEnum = pgEnum("agent_message_role", [
  "user",
  "assistant",
  "system",
  "tool",
]);
export const agentActionStatusEnum = pgEnum("agent_action_status", [
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
  "guard_blocked",
  // AI Guard post-pause feedback loop. Set when a rule directly auto-pauses
  // ads via ruleRunnerFrequent (no approval prompt up front). Stays in
  // `auto_executed` until the operator clicks 👍 Good (→ `approved`) or
  // ↩️ Re-open (→ `reverted`) in /telegram.
  "auto_executed",
  "reverted",
]);
export const journalActorTypeEnum = pgEnum("journal_actor_type", [
  "user",
  "agent",
  "rule",
  "system",
]);
export const capiEventStatusEnum = pgEnum("capi_event_status", [
  "pending",
  "sent",
  "failed",
]);

// ─── Identity & tenancy ────────────────────────────────────────────────────

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  currency: text("currency").notNull().default("MYR"),
  timezone: text("timezone").notNull().default("Asia/Kuala_Lumpur"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// `users` mirrors `auth.users` from Supabase Auth. We only store profile
// fields here; Supabase manages credentials.
export const users = pgTable("users", {
  id: uuid("id").primaryKey(), // = auth.users.id (for historical rows; new rows generate their own UUID)
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
  avatarUrl: text("avatar_url"),
  // scrypt:<salt-hex>:<hash-hex> — set by owner via Settings → Staff accounts.
  // Nullable for historical rows that haven't set a password yet (they sign
  // in via AUTH_BYPASS_MODE in the interim).
  passwordHash: text("password_hash"),
  // Per-user sidebar nav order — array of NAV hrefs. Null = use default order.
  navOrder: jsonb("nav_order").$type<string[] | null>(),
  createdAt: createdAt(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_members_org_user_uq").on(t.orgId, t.userId)],
);

// ─── Projects (groups of ad accounts within an org) ───────────────────────

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    archivedAt: ts("archived_at"),
    /** Substring that must appear in an ad's name for automated rules to act
     * on it (e.g. "AIA" for the AI 网络自由创业 project). Matched
     * case-insensitively via ILIKE in `lib/rules/engine.ts:evaluateRule()`.
     * Null/empty = no name filter (all ads under the project's accounts are
     * eligible — back-compat default). */
    adNamingCode: text("ad_naming_code"),
    /** Up to 4 hardcoded caption variations the operator wants pinned on
     * every cloned ad in this project. Read by `applyCreativePrefsToClonedAd`
     * during the clone path. Empty array means no auto-attach. */
    captionVariations: text("caption_variations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Boost-flow CTA preset. When both are set, ads created by the new-post
     * boost flow ship with a Meta call-to-action button + this link (the UTM
     * template is auto-appended at creation). Either NULL = no CTA injected. */
    defaultCallToActionType: text("default_call_to_action_type"),
    defaultLinkUrl: text("default_link_url"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug),
    index("projects_org_idx").on(t.orgId),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: projectRoleEnum("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_members_project_user_uq").on(t.projectId, t.userId),
    index("project_members_user_idx").on(t.userId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    orgId: orgId(),
    email: text("email").notNull(),
    role: orgRoleEnum("role").notNull().default("member"),
    /**
     * Optional: scope this invite to a single project. When non-null,
     * `acceptInvite()` also creates a `project_members` row for the new user.
     * When null (admin invites or legacy rows), the invitee sees all projects
     * their org role allows.
     */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    token: text("token").notNull().unique(),
    status: inviteStatusEnum("status").notNull().default("pending"),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("invites_email_idx").on(t.email)],
);

// ─── Meta connection (one row per connected Meta user) ─────────────────────

export const metaConnections = pgTable(
  "meta_connections",
  {
    id: id(),
    orgId: orgId(),
    metaUserId: text("meta_user_id").notNull(),
    metaUserName: text("meta_user_name"),
    // Long-lived user access token, encrypted via pgcrypto.
    // Read/write via SQL: pgp_sym_decrypt(token_encrypted, current_setting('app.encryption_key'))
    tokenEncrypted: bytea("token_encrypted").notNull(),
    tokenScopes: text("token_scopes").array().notNull(),
    tokenExpiresAt: ts("token_expires_at"),
    connectedBy: uuid("connected_by")
      .notNull()
      .references(() => users.id),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meta_connections_org_user_uq").on(t.orgId, t.metaUserId),
  ],
);

export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnections.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    metaAccountId: text("meta_account_id").notNull(), // act_xxx
    name: text("name").notNull(),
    currency: text("currency"),
    timezone: text("timezone"),
    businessId: text("business_id"),
    raw: jsonb("raw"),
    isRestricted: boolean("is_restricted").notNull().default(false),
    restrictedDetectedAt: timestamp("restricted_detected_at", {
      withTimezone: true,
    }),
    // Bumped once per full account sync. THE freshness signal — per-row
    // lastSyncedAt on ads/ad_sets/etc. only advances when a row actually
    // changes (conditional upserts), so it can't be used for "when did we
    // last talk to Meta".
    lastSyncedAt: ts("last_synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ad_accounts_org_meta_uq").on(t.orgId, t.metaAccountId),
    index("ad_accounts_project_idx").on(t.projectId),
  ],
);

export const pages = pgTable(
  "pages",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => metaConnections.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    metaPageId: text("meta_page_id").notNull(),
    name: text("name").notNull(),
    pageAccessTokenEncrypted: bytea("page_access_token_encrypted"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pages_org_meta_uq").on(t.orgId, t.metaPageId),
    index("pages_project_idx").on(t.projectId),
  ],
);

export const igAccounts = pgTable(
  "ig_accounts",
  {
    id: id(),
    orgId: orgId(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    metaIgUserId: text("meta_ig_user_id").notNull(),
    username: text("username"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ig_accounts_org_meta_uq").on(t.orgId, t.metaIgUserId),
    index("ig_accounts_project_idx").on(t.projectId),
  ],
);

// ─── Cached Meta entities ──────────────────────────────────────────────────

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    orgId: orgId(),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    metaCampaignId: text("meta_campaign_id").notNull(),
    name: text("name").notNull(),
    objective: text("objective"),
    status: adObjectStatusEnum("status").notNull(),
    effectiveStatus: adObjectStatusEnum("effective_status"),
    dailyBudget: bigint("daily_budget", { mode: "number" }), // cents
    lifetimeBudget: bigint("lifetime_budget", { mode: "number" }),
    raw: jsonb("raw"),
    // When true, the rules engine skips every ad inside this campaign — the
    // operator has decided to ride out cost spikes manually. AI Guard
    // (running inline inside the 14:00 KL midday-status cron) still flags
    // CPL spikes, so the operator hears about issues in /telegram but no
    // proposal ever auto-pauses an exempt campaign.
    autoPauseExempt: boolean("auto_pause_exempt").notNull().default(false),
    autoPauseExemptReason: text("auto_pause_exempt_reason"),
    autoPauseExemptAt: ts("auto_pause_exempt_at"),
    autoPauseExemptBy: uuid("auto_pause_exempt_by").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("campaigns_org_meta_uq").on(t.orgId, t.metaCampaignId),
    index("campaigns_account_idx").on(t.adAccountId),
  ],
);

export const adSets = pgTable(
  "ad_sets",
  {
    id: id(),
    orgId: orgId(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    metaAdSetId: text("meta_ad_set_id").notNull(),
    name: text("name").notNull(),
    status: adObjectStatusEnum("status").notNull(),
    effectiveStatus: adObjectStatusEnum("effective_status"),
    dailyBudget: bigint("daily_budget", { mode: "number" }),
    lifetimeBudget: bigint("lifetime_budget", { mode: "number" }),
    optimizationGoal: text("optimization_goal"),
    billingEvent: text("billing_event"),
    bidAmount: bigint("bid_amount", { mode: "number" }),
    targeting: jsonb("targeting"),
    /**
     * Meta's `created_time` for the ad set — when it was originally created.
     * Mirrors `ads.metaCreatedTime`; lets the AIA cross-account sync order the
     * 新广告组 clone list newest-first. Nullable for back-compat; the daily
     * full sync (the ad-set pull) backfills it on the next pass.
     */
    metaCreatedTime: ts("meta_created_time"),
    raw: jsonb("raw"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ad_sets_org_meta_uq").on(t.orgId, t.metaAdSetId),
    index("ad_sets_campaign_idx").on(t.campaignId),
  ],
);

export const ads = pgTable(
  "ads",
  {
    id: id(),
    orgId: orgId(),
    adSetId: uuid("ad_set_id")
      .notNull()
      .references(() => adSets.id, { onDelete: "cascade" }),
    metaAdId: text("meta_ad_id").notNull(),
    name: text("name").notNull(),
    status: adObjectStatusEnum("status").notNull(),
    effectiveStatus: adObjectStatusEnum("effective_status"),
    creativeId: uuid("creative_id"),
    /**
     * Meta's `created_time` for the ad — when it was originally launched.
     * Powers the Foreplay-style /creatives view: "days running" badge,
     * date-grouped timeline sections, "New launched (last 7d)" Lens counter.
     * Nullable for back-compat; the daily insights sync backfills it on the
     * next pass and the `creatives/backfill.all` event populates the history.
     */
    metaCreatedTime: ts("meta_created_time"),
    raw: jsonb("raw"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ads_org_meta_uq").on(t.orgId, t.metaAdId),
    index("ads_adset_idx").on(t.adSetId),
  ],
);

export const adCreatives = pgTable(
  "ad_creatives",
  {
    id: id(),
    orgId: orgId(),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    metaCreativeId: text("meta_creative_id").notNull(),
    name: text("name"),
    title: text("title"),
    body: text("body"),
    imageUrl: text("image_url"),
    /**
     * Meta's `thumbnail_url` field on the creative. Requested at 600×600
     * during sync (Meta's default is a blurry 64px). For video ads this is
     * the only still-frame available (image_url is null). For image ads Meta
     * returns both, and the card prefers the full-res `imageUrl` — this is
     * the fallback. URLs are Meta-CDN signed and expire after ~30d, so the
     * daily insights sync refreshes them. Nullable.
     */
    thumbnailUrl: text("thumbnail_url"),
    /**
     * Our own rehosted copy of the best available still (full-res image_url,
     * else the 600px thumbnail_url), uploaded to the public `creative-thumbs`
     * Supabase Storage bucket during sync. Unlike the Meta-CDN URLs above
     * this never expires, so the card prefers it first. Cached once per
     * creative (content is immutable per creative ID); null until the first
     * successful rehost. Best-effort — a failed cache leaves this null and
     * the card falls back to imageUrl/thumbnailUrl.
     */
    cachedThumbUrl: text("cached_thumb_url"),
    videoId: text("video_id"),
    /**
     * One of 'image' | 'video' | 'carousel' | 'reel'. Derived during sync
     * from the shape of `object_story_spec` (`video_data` → video,
     * `child_attachments` → carousel, etc.). Nullable for legacy rows; the
     * card grid filters on it and falls back to "image" when null.
     */
    mediaKind: text("media_kind"),
    objectStorySpec: jsonb("object_story_spec"),
    raw: jsonb("raw"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ad_creatives_org_meta_uq").on(t.orgId, t.metaCreativeId),
  ],
);

// ─── Creative boards / swipe file (Foreplay-style) ─────────────────────────

// A board is a named collection of inspiring creatives the operator has
// pinned for reference. Powers /creatives/boards. Inspired by Foreplay's
// "Outstanding Hooks", "Product Variation Ads", "UGC Inspo", "Competitor
// Ideas" left-nav.
//
// `kind` distinguishes boards of OWN ads (own — Phase 2 only emits this)
// vs boards of THIRD-PARTY references that come from the Ad Library
// (inspiration — wired in Phase 4). Items in an inspiration board carry
// their data in `board_items.externalRef` instead of pointing at an
// `ads.id`.
export const creativeBoards = pgTable(
  "creative_boards",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("own"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("creative_boards_org_project_idx").on(t.orgId, t.projectId)],
);

// One row per (board, creative). For own-ad references, `adId` points at
// the local ads row. For third-party items (Phase 4 ad-library saves +
// Phase 5 Spyder competitor pins), `adId` is null and `externalRef` carries
// the data needed to render the card (archive_id, snapshot_url, brand
// name, caption, etc.).
//
// `hookNote` is a free-text operator annotation — "what's the hook here?"
// — surfaced as a textarea on the per-board view and fed into the Phase 6
// AI Brief Generator's prompt to teach Jarvis why this ad caught the
// operator's eye.
export const boardItems = pgTable(
  "board_items",
  {
    id: id(),
    orgId: orgId(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => creativeBoards.id, { onDelete: "cascade" }),
    adId: uuid("ad_id").references(() => ads.id, { onDelete: "cascade" }),
    externalRef: jsonb("external_ref"),
    hookNote: text("hook_note"),
    sortOrder: integer("sort_order").notNull().default(0),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    // Prevent duplicate saves of the same ad to the same board. The unique
    // index treats NULL adId as distinct (the default Postgres behaviour),
    // which is intentional — multiple externalRef items can coexist in a
    // single board without colliding.
    uniqueIndex("board_items_board_ad_uq").on(t.boardId, t.adId),
    index("board_items_board_sort_idx").on(t.boardId, t.sortOrder),
  ],
);

// ─── Spyder / Competitor tracking (Foreplay-style) ─────────────────────────

// A named competitor whose currently-running ads we snapshot daily. The
// operator either provides a Meta Page ID (preferred — exact match in
// `/ads_archive`) or a list of search_terms (fuzzy). `countries` defaults
// to ['MY'] to match Andi's market; each value is an ISO 3166-1 alpha-2.
//
// `lastSnapshottedAt` is bumped at the end of each successful Inngest
// snapshot run; we use it to detect brands that have never been crawled
// yet (UI shows "Snapshot now" prominently).
export const competitorBrands = pgTable(
  "competitor_brands",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    metaPageId: text("meta_page_id"),
    searchTerms: text("search_terms")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    countries: text("countries")
      .array()
      .notNull()
      .default(sql`'{"MY"}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    lastSnapshottedAt: ts("last_snapshotted_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("competitor_brands_org_project_idx").on(t.orgId, t.projectId),
  ],
);

// One row per (brand, archive_id). Inserted on first sighting; the daily
// cron updates `lastSeenAt` to today every time the ad is still showing,
// and sets `endedAt = today` on the run that first finds the ad missing.
// `payload` is the raw `/ads_archive` row so we can re-render the card
// even after Meta deletes the snapshot URL.
//
// Limitation: Meta gives paused-then-resumed ads a new archive_id, so
// "30 days continuous running" can break visually if an ad pauses. The
// per-brand UI sums cumulative days across archive_ids with the same
// creative body to mitigate this, but the underlying rows stay distinct.
export const competitorAdSnapshots = pgTable(
  "competitor_ad_snapshots",
  {
    id: id(),
    orgId: orgId(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => competitorBrands.id, { onDelete: "cascade" }),
    archiveId: text("archive_id").notNull(),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    endedAt: ts("ended_at"),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("competitor_snapshots_brand_archive_uq").on(
      t.brandId,
      t.archiveId,
    ),
    index("competitor_snapshots_brand_seen_idx").on(t.brandId, t.lastSeenAt),
  ],
);

// ─── Insights cache ────────────────────────────────────────────────────────

export const insightsDaily = pgTable(
  "insights_daily",
  {
    id: id(),
    orgId: orgId(),
    level: text("level").notNull(), // 'account' | 'campaign' | 'adset' | 'ad'
    entityId: uuid("entity_id").notNull(), // FK varies by level — enforced in app code
    metaEntityId: text("meta_entity_id").notNull(),
    date: ts("date").notNull(),
    impressions: bigint("impressions", { mode: "number" }),
    reach: bigint("reach", { mode: "number" }),
    spend: numeric("spend", { precision: 14, scale: 4 }),
    clicks: bigint("clicks", { mode: "number" }),
    results: bigint("results", { mode: "number" }),
    costPerResult: numeric("cost_per_result", { precision: 14, scale: 4 }),
    ctr: numeric("ctr", { precision: 8, scale: 4 }),
    cpm: numeric("cpm", { precision: 14, scale: 4 }),
    cpc: numeric("cpc", { precision: 14, scale: 4 }),
    purchaseRoas: numeric("purchase_roas", { precision: 14, scale: 4 }),
    purchases: bigint("purchases", { mode: "number" }),       // total purchase actions (on+off site)
    webPurchases: bigint("web_purchases", { mode: "number" }), // pixel purchase events only
    conversionValue: numeric("conversion_value", { precision: 18, scale: 4 }), // revenue from pixel purchases
    breakdownDim: text("breakdown_dim"), // null for total; e.g. 'age', 'gender'
    breakdownValue: text("breakdown_value"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [
    // CRITICAL: this index MUST be `NULLS NOT DISTINCT` in the database —
    // without it, rows with NULL breakdown_dim / breakdown_value never
    // collide on insert and onConflictDoUpdate silently INSERTs a fresh
    // duplicate row on every re-sync. Discovered 2026-05-12 after 107,004
    // duplicate rows had accumulated.
    //
    // Drizzle 0.45.2 doesn't expose `.nullsNotDistinct()`, so the NULLS
    // NOT DISTINCT clause is applied via the raw-SQL migration
    // `supabase/migrations/0015_insights_daily_uq_nulls_not_distinct.sql`
    // and the one-off cleanup in
    // `scripts/fix-insights-dedup-and-backfill.ts`. If you ever drop and
    // recreate this index via `db:generate`, you MUST re-apply the
    // NULLS NOT DISTINCT clause manually or the bug returns.
    uniqueIndex("insights_daily_uq").on(
      t.orgId,
      t.level,
      t.metaEntityId,
      t.date,
      t.breakdownDim,
      t.breakdownValue,
    ),
    index("insights_daily_entity_date_idx").on(t.entityId, t.date),
  ],
);

// ─── Automated rules ───────────────────────────────────────────────────────

export const automatedRules = pgTable(
  "automated_rules",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    scope: ruleScopeEnum("scope").notNull(),
    // Tree-shaped condition; validated by app-level Zod schema.
    conditions: jsonb("conditions").notNull(),
    action: ruleActionTypeEnum("action").notNull(),
    actionParams: jsonb("action_params"),
    trigger: ruleTriggerEnum("trigger").notNull(),
    // For 'scheduled': cron expression in org timezone.
    // For 'interval': minutes between checks.
    schedule: text("schedule"),
    intervalMinutes: integer("interval_minutes"),
    enabled: boolean("enabled").notNull().default(true),
    syncToMeta: boolean("sync_to_meta").notNull().default(true),
    metaRuleId: text("meta_rule_id"),
    appliesToProjectId: uuid("applies_to_project_id").references(
      () => projects.id,
      { onDelete: "cascade" },
    ),
    appliesToAdAccountId: uuid("applies_to_ad_account_id").references(
      () => adAccounts.id,
      { onDelete: "cascade" },
    ),
    lastRanAt: ts("last_ran_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rules_org_enabled_idx").on(t.orgId, t.enabled)],
);

export const ruleExecutions = pgTable(
  "rule_executions",
  {
    id: id(),
    orgId: orgId(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automatedRules.id, { onDelete: "cascade" }),
    ranAt: ts("ran_at").notNull().defaultNow(),
    matched: integer("matched").notNull().default(0),
    actionsTaken: integer("actions_taken").notNull().default(0),
    dryRun: boolean("dry_run").notNull().default(false),
    summary: jsonb("summary"), // [{ entityId, before, after, ok, error }]
    error: text("error"),
  },
  (t) => [index("rule_executions_rule_time_idx").on(t.ruleId, t.ranAt)],
);

// ─── Content composer ─────────────────────────────────────────────────────

export const posts = pgTable(
  "posts",
  {
    id: id(),
    orgId: orgId(),
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),
    igAccountId: uuid("ig_account_id").references(() => igAccounts.id, {
      onDelete: "set null",
    }),
    targetPlatforms: postPlatformEnum("target_platforms").array().notNull(),
    mediaKind: postMediaKindEnum("media_kind").notNull(),
    caption: text("caption"),
    firstComment: text("first_comment"),
    linkUrl: text("link_url"),
    status: postStatusEnum("status").notNull().default("draft"),
    scheduledFor: ts("scheduled_for"),
    publishedFb: jsonb("published_fb"), // { postId, permalink, publishedAt }
    publishedIg: jsonb("published_ig"),
    error: text("error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("posts_org_status_idx").on(t.orgId, t.status),
    index("posts_scheduled_idx").on(t.scheduledFor),
  ],
);

export const postAssets = pgTable(
  "post_assets",
  {
    id: id(),
    orgId: orgId(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    storagePath: text("storage_path").notNull(), // Supabase storage key
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    altText: text("alt_text"),
  },
  (t) => [index("post_assets_post_order_idx").on(t.postId, t.sortOrder)],
);

// ─── Copywriting library ───────────────────────────────────────────────────

export const copyEntries = pgTable(
  "copy_entries",
  {
    id: id(),
    orgId: orgId(),
    title: text("title").notNull(),
    painPointSlug: text("pain_point_slug"), // ties into bulk-variation factory naming
    audience: text("audience"),
    funnelStage: text("funnel_stage"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    notes: text("notes"),
    // Phase 6: distinguishes AI-generated creative briefs from regular
    // hand-written copy entries. Default 'copy' keeps existing rows
    // backwards-compatible; the brief generator stamps 'brief' so the
    // /creatives/briefs list can filter them in and /copy can filter
    // them out.
    kind: text("kind").notNull().default("copy"),
    // Nullable so legacy copy_entries (org-wide, no project tag) keep
    // working. Briefs always carry a project_id since they're rendered
    // inside the project-scoped /creatives surface.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    // Brief provenance. Either points at one of our own ads OR at a board
    // item (which itself may be a saved external ad-library result). Both
    // can be null when the entry is hand-typed copy, not a brief.
    sourceAdId: uuid("source_ad_id").references(() => ads.id, {
      onDelete: "set null",
    }),
    sourceBoardItemId: uuid("source_board_item_id").references(
      () => boardItems.id,
      { onDelete: "set null" },
    ),
    // Brief-specific structured fields. Free-text on every entry so the
    // operator can type a hand-written brief too; the AI generator just
    // fills them in.
    productName: text("product_name"),
    visualDirection: text("visual_direction"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("copy_entries_org_idx").on(t.orgId),
    index("copy_entries_kind_idx").on(t.orgId, t.kind),
    index("copy_entries_project_idx").on(t.projectId),
  ],
);

export const copyVariants = pgTable(
  "copy_variants",
  {
    id: id(),
    orgId: orgId(),
    copyEntryId: uuid("copy_entry_id")
      .notNull()
      .references(() => copyEntries.id, { onDelete: "cascade" }),
    variantNumber: integer("variant_number").notNull(),
    primaryText: text("primary_text").notNull(),
    headline: text("headline"),
    description: text("description"),
    callToAction: text("call_to_action"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("copy_variants_entry_num_uq").on(t.copyEntryId, t.variantNumber),
  ],
);

// ─── AI agent ──────────────────────────────────────────────────────────────

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title"),
    // 'chat' = normal user-initiated chat
    // 'brief' = system-generated periodic summary (morning brief, etc.)
    kind: text("kind").notNull().default("chat"),
    // Briefs are project-scoped; chats may be too in future. Nullable for now.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    // Phase L: when a brief is fanned out per ad account (multi-account
    // projects only), this points at the specific ad_account the brief
    // covers. Null for project-level briefs and all chat conversations.
    adAccountId: uuid("ad_account_id").references(() => adAccounts.id, {
      onDelete: "set null",
    }),
    // Set when the brief is mirrored to a Telegram chat (idempotency + future edits).
    telegramChatId: text("telegram_chat_id"),
    telegramMessageId: text("telegram_message_id"),
    // Structured snapshot of the data used to render this conversation. For
    // kind='brief' we persist the BriefData so /api/briefs/[id]/report can
    // re-render a rich HTML dashboard later. Null for chat conversations.
    data: jsonb("data"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agent_conv_org_user_idx").on(t.orgId, t.userId),
    index("agent_conv_kind_idx").on(t.orgId, t.kind),
  ],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    orgId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    role: agentMessageRoleEnum("role").notNull(),
    // content blocks per Anthropic SDK shape (text, tool_use, tool_result, etc.)
    content: jsonb("content").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_msg_conv_idx").on(t.conversationId, t.createdAt)],
);

export const agentActions = pgTable(
  "agent_actions",
  {
    id: id(),
    orgId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    // Nullable so a tool can insert a pending action *during* an agent run,
    // before the assistant message has been persisted. Backfilled after.
    messageId: uuid("message_id").references(() => agentMessages.id, {
      onDelete: "cascade",
    }),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").notNull(),
    preview: jsonb("preview"), // before/after snapshot for the approval card
    status: agentActionStatusEnum("status").notNull().default("proposed"),
    guardVerdict: jsonb("guard_verdict"), // { allowed, reasons[] }
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: ts("approved_at"),
    executedAt: ts("executed_at"),
    result: jsonb("result"),
    error: text("error"),
    // Set when the proposal is posted as a Telegram message; used to edit the
    // message in place when the operator approves/rejects from Telegram or web.
    telegramChatId: text("telegram_chat_id"),
    telegramMessageId: text("telegram_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_actions_status_idx").on(t.orgId, t.status),
    // Serves the 加推记录 history query on /content (filters org + tool_name,
    // orders by created_at) and the re-boost duplicate guard.
    index("agent_actions_tool_created_idx").on(
      t.orgId,
      t.toolName,
      t.createdAt,
    ),
  ],
);

// ─── Decision Journal (append-only) ────────────────────────────────────────

export const decisionJournal = pgTable(
  "decision_journal",
  {
    id: id(),
    orgId: orgId(),
    // Nullable: org-wide system events (cron-ticks, dev setup) carry no project.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    actorType: journalActorTypeEnum("actor_type").notNull(),
    actorRef: text("actor_ref"), // userId / ruleId / agentActionId / 'system'
    summary: text("summary").notNull(),
    reasoning: text("reasoning"),
    entityKind: text("entity_kind"), // 'campaign' | 'adset' | 'ad' | 'rule' | 'post' | …
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("journal_org_time_idx").on(t.orgId, t.occurredAt),
    index("journal_project_time_idx").on(t.projectId, t.occurredAt),
    index("journal_entity_idx").on(t.entityKind, t.entityId),
  ],
);

// ─── Conversions API ───────────────────────────────────────────────────────

export const pixelEvents = pgTable(
  "pixel_events",
  {
    id: id(),
    orgId: orgId(),
    pixelId: text("pixel_id").notNull(),
    eventName: text("event_name").notNull(), // 'Purchase', 'Lead', etc.
    eventTime: ts("event_time").notNull(),
    eventId: text("event_id").notNull(), // dedup key
    eventSourceUrl: text("event_source_url"),
    actionSource: text("action_source"), // 'website' | 'email' | …
    userDataHashed: jsonb("user_data_hashed").notNull(), // em, ph, fbp, fbc, etc.
    customData: jsonb("custom_data"),
    status: capiEventStatusEnum("status").notNull().default("pending"),
    metaResponse: jsonb("meta_response"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pixel_events_dedup_uq").on(t.orgId, t.pixelId, t.eventId),
    index("pixel_events_org_status_idx").on(t.orgId, t.status),
  ],
);

// ─── Org settings ──────────────────────────────────────────────────────────

export const orgSettings = pgTable("org_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  defaultPixelId: text("default_pixel_id"),
  pixelAutoAttach: boolean("pixel_auto_attach").notNull().default(true),
  capiAccessTokenEncrypted: bytea("capi_access_token_encrypted"),
  // Per-org webhook secret for /api/capi/events. Rotate by re-saving.
  capiWebhookSecret: text("capi_webhook_secret"),
  // Optional Meta `test_event_code` while integrating CAPI.
  capiTestEventCode: text("capi_test_event_code"),
  // Default ad creation prefs that the user toggled off in Meta:
  enableSiteRecommendations: boolean("enable_site_recommendations")
    .notNull()
    .default(false),
  enableMultiAdvertiserAds: boolean("enable_multi_advertiser_ads")
    .notNull()
    .default(false),
  enableAdvantageCreative: boolean("enable_advantage_creative")
    .notNull()
    .default(false),
  // AI Guard hard caps
  guardMaxBudgetChangePct: integer("guard_max_budget_change_pct")
    .notNull()
    .default(50),
  guardMinSpendBeforePauseMyr: numeric(
    "guard_min_spend_before_pause_myr",
    { precision: 14, scale: 2 },
  )
    .notNull()
    .default("0"),
  guardDailyActionQuota: integer("guard_daily_action_quota")
    .notNull()
    .default(50),
  systemPrompt: text("system_prompt"), // org-specific agent persona/strategy
  agentName: text("agent_name").notNull().default("Jarvis"),
  updatedAt: updatedAt(),
});

// ─── Agent preference summaries (recursive learning) ──────────────────────

// Weekly distillation of how the operator approved / rejected / tweaked
// proposals over the past 7 days. The most-recent row per project is appended
// to the agent's system prompt for the following week, giving the model
// context that survives across sessions — the "recursive learning" behaviour
// shown in the reel.
export const agentPreferenceSummaries = pgTable(
  "agent_preference_summaries",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    // Inclusive start of the week (Mon 00:00 KL) the summary covers.
    weekStart: ts("week_start").notNull(),
    summaryText: text("summary_text").notNull(),
    // Counts that fed into the summary, kept for audit / debugging.
    proposalsApproved: integer("proposals_approved").notNull().default(0),
    proposalsRejected: integer("proposals_rejected").notNull().default(0),
    // Model used + token usage for the summarisation call.
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_pref_summary_org_project_week_uq").on(
      t.orgId,
      t.projectId,
      t.weekStart,
    ),
    index("agent_pref_summary_recent_idx").on(t.orgId, t.projectId, t.createdAt),
  ],
);

// ─── WhatsApp connections (delivery channel) ──────────────────────────────

// One row per (org, recipient_phone). The bot uses Meta's WhatsApp Cloud
// API — same Graph API as the rest of the app, just a different endpoint.
// access_token_encrypted holds a long-lived system-user token from the
// Meta WhatsApp Business app, encrypted via the same AES-256-GCM helper
// as Meta connections.
//
// Caveat baked into the UI: the Cloud API enforces a 24-hour customer
// service window. Outbound text + interactive button messages only work
// when the recipient has messaged the bot in the last 24h. Outside that
// window we'd need pre-approved template messages (multi-day Meta
// approval). The dispatch helpers attempt the call and surface the
// failure to the operator rather than silently dropping.
export const whatsappConnections = pgTable(
  "whatsapp_connections",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    waPhoneNumberId: text("wa_phone_number_id").notNull(),
    waBusinessAccountId: text("wa_business_account_id"),
    accessTokenEncrypted: bytea("access_token_encrypted").notNull(),
    recipientPhone: text("recipient_phone").notNull(), // E.164, e.g. +60123456789
    recipientLabel: text("recipient_label"),
    verifiedAt: ts("verified_at"),
    pairedBy: uuid("paired_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("whatsapp_connections_org_phone_uq").on(
      t.orgId,
      t.recipientPhone,
    ),
    index("whatsapp_connections_project_idx").on(t.orgId, t.projectId),
  ],
);

// ─── Email recipients (delivery channel) ──────────────────────────────────

// One row per (org, email). project_id null => org-wide; non-null => scoped
// to that project. verify_token is a per-row nonce sent to the recipient on
// add; clicking the link in the verification email clears the token + sets
// verified_at. We never send briefs / proposals to a row with verified_at
// null — guards against typo'd addresses receiving operator-confidential
// data.
export const emailRecipients = pgTable(
  "email_recipients",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    email: text("email").notNull(),
    label: text("label"),
    verifyToken: text("verify_token"),
    verifiedAt: ts("verified_at"),
    pairedBy: uuid("paired_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("email_recipients_org_email_uq").on(t.orgId, t.email),
    index("email_recipients_project_idx").on(t.orgId, t.projectId),
  ],
);

// ─── Telegram connections ──────────────────────────────────────────────────

// One row per (org, chat). project_id null => org-wide chat that receives
// briefs/proposals for every project in the org. Non-null => scoped to that
// single project (mirrors the project switcher behaviour of the web app).
export const telegramConnections = pgTable(
  "telegram_connections",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    // Telegram chat IDs are int64; group/channel IDs are negative. Stored as
    // text to avoid bigint serialization headaches.
    chatId: text("chat_id").notNull(),
    chatTitle: text("chat_title"),
    chatType: text("chat_type"), // 'private' | 'group' | 'supergroup' | 'channel'
    pairedBy: uuid("paired_by")
      .notNull()
      .references(() => users.id),
    // Random nonce returned to the user when they paste a chat ID. Lets us
    // verify the bot actually got added before we trust the connection.
    verifiedAt: ts("verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("telegram_connections_org_chat_uq").on(t.orgId, t.chatId),
    index("telegram_connections_project_idx").on(t.orgId, t.projectId),
  ],
);

// ─── Web Push subscriptions (PWA phone notifications) ─────────────────────

// One row per browser/device push endpoint. Scoped org+user, NOT per-project:
// the operator wants a single phone to receive pushes for all his brands, so
// deliverWebPush sends to every subscription in the org. `endpoint` is the
// push-service URL (globally unique per device+app install); p256dh + auth are
// the client's encryption keys (base64url) required by the Web Push protocol.
// A subscription that returns 404/410 on send is stale (app uninstalled /
// permission revoked) and gets pruned in place.
export const webPushSubscriptions = pgTable(
  "web_push_subscriptions",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("web_push_subscriptions_endpoint_uq").on(t.endpoint),
    index("web_push_subscriptions_org_idx").on(t.orgId),
  ],
);

// ─── AI Guard dedup table (Phase J3) ─────────────────────────────────────

// One row per (org, ad, kind) — last_alerted_at gates re-firing the same
// alert on the same ad within a 24h window. AI Guard now runs once daily
// inside the 14:00 KL midday-status cron; the dedup table still matters
// because a hit re-detected the next afternoon should not refire if the
// previous alert is still inside the 24h window.
//
// `kind` is open text rather than an enum so adding a new alert kind
// later (e.g. 'roas_collapse') doesn't require a migration. Today's
// values: 'cpm_spike' | 'freq_creep' | 'scale_ready' | 'cpl_warning'.
export const agentAlertsSeen = pgTable(
  "agent_alerts_seen",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    adId: uuid("ad_id")
      .notNull()
      .references(() => ads.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    lastAlertedAt: ts("last_alerted_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_alerts_seen_org_ad_kind_uq").on(
      t.orgId,
      t.adId,
      t.kind,
    ),
    index("agent_alerts_seen_project_idx").on(t.orgId, t.projectId),
  ],
);

// ─── Page-post boost watcher ──────────────────────────────────────────────

// Per-project config for the page-post-watch cron: which campaign new
// organic posts should be boosted into, and which adset to duplicate as the
// template. One row per project. Set `bootstrapped_at` to null to force the
// next poll to re-baseline (e.g. after the operator changes the reference
// adset and doesn't want backlog notifications for old posts).
export const projectBoostConfigs = pgTable(
  "project_boost_configs",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    primaryAdAccountId: uuid("primary_ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    primaryCampaignId: uuid("primary_campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    primaryReferenceAdSetId: uuid("primary_reference_ad_set_id")
      .notNull()
      .references(() => adSets.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    bootstrappedAt: ts("bootstrapped_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("project_boost_configs_project_uq").on(t.projectId)],
);

// Extra destination campaigns for the page-post-watch cron — fan-out targets
// beyond the project's primary campaign (e.g. GT2, GT3 in the same ad
// account). The reference ad set is shared across all targets (taken from
// projectBoostConfigs.primaryReferenceAdSetId); only the destination
// campaign varies per row.
export const projectBoostTargetCampaigns = pgTable(
  "project_boost_target_campaigns",
  {
    id: id(),
    orgId: orgId(),
    projectBoostConfigId: uuid("project_boost_config_id")
      .notNull()
      .references(() => projectBoostConfigs.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("project_boost_target_campaigns_uq").on(
      t.projectBoostConfigId,
      t.campaignId,
    ),
  ],
);

// Dedup table for the page-post-watch cron. One row per (org, page, post)
// the watcher has surfaced — guarantees we don't re-prompt the operator for
// the same post even if it sticks around in /{page}/published_posts for
// weeks. Parallel to agent_alerts_seen but post-keyed instead of ad-keyed
// (the existing table's ad_id column is notNull FK to ads).
export const pagePostAlertsSeen = pgTable(
  "page_post_alerts_seen",
  {
    id: id(),
    orgId: orgId(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    metaPostId: text("meta_post_id").notNull(),
    // 'fb' | 'reel' | 'ig_xpost' — informational only, not enforced.
    postKind: text("post_kind").notNull(),
    // Destination campaign this post was proposed for. With multi-target
    // fan-out the same post can be proposed once per target campaign, so the
    // dedup key carries campaignId.
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    seenAt: ts("seen_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_post_alerts_seen_uq").on(
      t.orgId,
      t.pageId,
      t.metaPostId,
      t.campaignId,
    ),
    index("page_post_alerts_seen_org_idx").on(t.orgId, t.seenAt),
  ],
);

// ─── Meta API audit log ────────────────────────────────────────────────────

export const metaApiCalls = pgTable(
  "meta_api_calls",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id").references(() => metaConnections.id, {
      onDelete: "set null",
    }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status"),
    durationMs: integer("duration_ms"),
    requestBody: jsonb("request_body"),
    responseExcerpt: jsonb("response_excerpt"),
    error: text("error"),
    calledBy: text("called_by"), // 'user' | 'rule:<id>' | 'agent:<id>' | 'sync'
    createdAt: createdAt(),
  },
  (t) => [index("meta_api_calls_org_time_idx").on(t.orgId, t.createdAt)],
);

// ─── Webinar reports ──────────────────────────────────────────────────────
//
// Per-project config that drives the 10:00 KL `whatsapp-report-10-kl` Inngest
// cron. The cron fetches the WhatsApp-formatted block from `sourceUrl` and
// posts it via `notifyOps()` so it lands in /telegram + Telegram chat +
// email/WhatsApp fan-out.
//
// One row per project (projectId is UNIQUE). To disable a project's daily
// report without deleting the row, flip `enabled` to false.

export const webinarReports = pgTable(
  "webinar_reports",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" })
      .unique(),
    /** Webinar event date in the project's timezone (Asia/Kuala_Lumpur for
     * Andi's projects). Drives countdownDays + session ID in the report. */
    eventDate: date("event_date").notNull(),
    /** Display label, e.g. "WEBINAR 0610". */
    webinarName: text("webinar_name").notNull(),
    /** Base URL of the deployed dashboard exposing /api/whatsapp-text.
     * e.g. "https://ads-reporting-aia.vercel.app". No trailing slash. */
    sourceUrl: text("source_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webinar_reports_org_idx").on(t.orgId)],
);

// ─── Cross-account campaign clone jobs ─────────────────────────────────────
//
// Backs the in-app "Clone campaign → another account" button. A durable
// Inngest job (`clone-campaign-to-account`) clones every live ad set of a
// source campaign into a same-named destination campaign in another ad
// account — one `step.run` per ad set — and writes progress here after each so
// the /campaigns/clone-jobs page can poll it (the app has no websockets).
// See lib/inngest/clone-campaign-to-account.ts.

export const cloneJobStatusEnum = pgEnum("clone_job_status", [
  "queued",
  "running",
  "done",
  "done_with_errors",
  "failed",
]);

export const cloneJobs = pgTable(
  "clone_jobs",
  {
    id: id(),
    orgId: orgId(),
    sourceMetaAccountId: text("source_meta_account_id").notNull(), // act_xxx
    sourceCampaignId: uuid("source_campaign_id").notNull(), // local UUID
    sourceCampaignName: text("source_campaign_name").notNull(),
    destMetaAccountId: text("dest_meta_account_id").notNull(), // act_xxx
    destCampaignId: uuid("dest_campaign_id").notNull(), // local UUID
    destCampaignName: text("dest_campaign_name").notNull(),
    destAccountName: text("dest_account_name").notNull(),
    status: cloneJobStatusEnum("status").notNull().default("queued"),
    total: integer("total").notNull().default(0),
    cloned: integer("cloned").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // [{ name, status: 'cloned'|'skipped'|'failed', newAdSetMetaId?, needsManualIgFix?, error? }]
    perAdSet: jsonb("per_ad_set").notNull().default(sql`'[]'::jsonb`),
    triggeredBy: uuid("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("clone_jobs_org_status_idx").on(t.orgId, t.status),
    index("clone_jobs_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

// ─── Variation-factory bulk-launch runs ────────────────────────────────────
//
// Backs the factory's Bulk mode: N uploaded creatives → N new PAUSED ad sets
// (each duplicated from a template ad set via Meta /copies) with exactly one
// PAUSED draft ad inside. A durable Inngest job (`factory-run`) processes the
// batch in chunks and writes progress here after each so the
// /campaigns/factory/runs/[runId] page can poll it.
// See lib/inngest/factory-run.ts.

export const factoryRunStatusEnum = pgEnum("factory_run_status", [
  "queued",
  "running",
  "done",
  "done_with_errors",
  "failed",
]);

export const factoryRuns = pgTable(
  "factory_runs",
  {
    id: id(),
    orgId: orgId(),
    adAccountId: uuid("ad_account_id").notNull(), // local UUID
    campaignId: uuid("campaign_id").notNull(), // local UUID — destination campaign
    templateAdSetId: uuid("template_ad_set_id").notNull(), // local UUID — targeting/budget source
    pageId: uuid("page_id").notNull(), // local UUID — creative source Page
    batchSlug: text("batch_slug").notNull(),
    linkUrl: text("link_url"),
    callToAction: text("call_to_action"),
    status: factoryRunStatusEnum("status").notNull().default("queued"),
    total: integer("total").notNull().default(0),
    created: integer("created").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // [{ index, kind: "image"|"video", fileName, assetUrl, copyIndex, adSetName,
    //    adName, status: "pending"|"video_uploaded"|"video_ready"|"adset_created"
    //      |"created"|"skipped"|"failed",
    //    metaVideoId?, thumbnailUrl?, metaAdSetId?, localAdSetId?,
    //    metaCreativeId?, metaAdId?, draftAdId?, error? }]
    items: jsonb("items").notNull().default(sql`'[]'::jsonb`),
    // [{ primaryText, headline?, description? }] — 1..4 entries paired
    // round-robin onto items; CTA + link are run-level.
    copySet: jsonb("copy_set").notNull().default(sql`'[]'::jsonb`),
    triggeredBy: uuid("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("factory_runs_org_status_idx").on(t.orgId, t.status),
    index("factory_runs_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

// ─── /telegram inbox read receipts ────────────────────────────────────────

// One "last read" cursor per (project, user). When a staff member opens the
// in-app /telegram inbox for a project, `last_read_at` is stamped to now. A
// feed bubble (brief / action / message) is "read by" that staff member iff
// their cursor `last_read_at >= bubble.created_at` — the same way WhatsApp
// computes group read receipts, without a row per message. The `✓✓` on each
// bubble turns blue once every project member's cursor has passed it.
export const inboxReadReceipts = pgTable(
  "inbox_read_receipts",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: ts("last_read_at").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inbox_read_receipts_project_user_uq").on(
      t.projectId,
      t.userId,
    ),
  ],
);

// ─── Cron heartbeats (Inngest watchdog) ─────────────────────────────────────
// One row per Inngest function, upserted by HeartbeatMiddleware on every run
// start. The /api/cron/inngest-watchdog Vercel cron (outside Inngest, so it
// survives an Inngest app desync) reads these to detect functions that
// silently dropped from registration — the 05-28 / 06-28 incident class.
// Global infra table: deliberately not org-scoped.

export const cronHeartbeats = pgTable("cron_heartbeats", {
  functionId: text("function_id").primaryKey(),
  lastRunAt: ts("last_run_at").notNull(),
  lastAlertedAt: ts("last_alerted_at"),
});

// ─── Inngest usage counter (free-tier quota watch) ──────────────────────────
// Self-tracked approximation of Inngest's own "executions" meter (1 per
// function run + 1 per step.run), since Inngest exposes no usage/billing
// API. Upserted by UsageCounterMiddleware on every non-memoized step and on
// every run's terminal outcome. One row per calendar month; the watchdog
// alerts at 70/85/95% of the free tier's 50,000/month cap (dedup via
// lastAlertedThreshold). Global infra table: deliberately not org-scoped.

export const inngestUsageMonthly = pgTable("inngest_usage_monthly", {
  month: text("month").primaryKey(), // "2026-07"
  executionCount: bigint("execution_count", { mode: "number" })
    .notNull()
    .default(0),
  lastAlertedThreshold: integer("last_alerted_threshold"), // 70 | 85 | 95
});
