import {
  META_API_VERSION,
  MetaApiError,
  type MetaErrorResponse,
  type MetaList,
  type MetaUser,
  type MetaAdAccount,
  type MetaPage,
  type MetaIgUser,
  type MetaCampaign,
  type MetaAdSet,
  type MetaAd,
  type MetaAdLibraryAd,
  type MetaInsightsRow,
} from "./types";

type Method = "GET" | "POST" | "DELETE";

/**
 * Meta's default `/campaigns`, `/adsets`, `/ads` queries hide ARCHIVED.
 * Pass these filters to surface every status the operator might still care
 * about. Per-entity because Meta rejects "Invalid parameter" if you pass an
 * ad-only status (PENDING_REVIEW etc.) to the /adsets endpoint, and so on.
 */
// Meta's /{ad_account}/{adsets|ads|campaigns} endpoints reject "DELETED" in
// effective_status with subcode 1815001 ("Requesting for deleted objects is
// not supported in this endpoint"). Sync was throwing on every account because
// of this until 2026-05-10. Use /search or the per-id read for tombstones if
// we ever need them.
const ALL_CAMPAIGN_STATUSES = JSON.stringify([
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
]);

const ALL_ADSET_STATUSES = JSON.stringify([
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "CAMPAIGN_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
]);

const ALL_AD_STATUSES = JSON.stringify([
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
]);

type RequestOptions = {
  method?: Method;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: Record<string, unknown> | FormData;
  // Identifies the caller for the meta_api_calls audit log.
  calledBy?: string;
  signal?: AbortSignal;
};

type AuditEntry = {
  method: Method;
  path: string;
  status: number | null;
  durationMs: number;
  requestBody?: unknown;
  responseExcerpt?: unknown;
  error?: string;
  calledBy?: string;
};

/**
 * Audit log sink. `record` is required; `beginBatch` + `flush` are optional
 * and only used by callers that want to collapse many calls into one bulk
 * INSERT (e.g., `syncProject`). Writers without batching just no-op those.
 */
type Auditor = {
  record(entry: AuditEntry): Promise<void> | void;
  beginBatch?(): void;
  flush?(): Promise<void> | void;
};

export type MetaClientConfig = {
  /** Long-lived user access token, OR a page access token, OR system user token. */
  accessToken: string;
  /** Optional: org context, used by the audit writer for tagging. */
  orgId?: string;
  connectionId?: string;
  /** Override base URL (for testing). */
  baseUrl?: string;
  /** Audit log writer (DB insert into meta_api_calls). Optional in tests. */
  audit?: Auditor;
  /** Max retries for retriable errors. Default 3. */
  maxRetries?: number;
};

const DEFAULT_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const RETRIABLE_HTTP = new Set([429, 500, 502, 503, 504]);
// Meta-specific transient codes worth retrying.
const RETRIABLE_META_CODES = new Set([1, 2, 4, 17, 32, 613]);

export class MetaClient {
  private readonly cfg: Required<
    Pick<MetaClientConfig, "accessToken" | "baseUrl" | "maxRetries">
  > &
    MetaClientConfig;

  constructor(cfg: MetaClientConfig) {
    this.cfg = {
      ...cfg,
      baseUrl: cfg.baseUrl ?? DEFAULT_BASE,
      maxRetries: cfg.maxRetries ?? 3,
    };
  }

  // ─── Low-level request ───────────────────────────────────────────────────

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const url = this.buildUrl(path, opts.query);

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.cfg.maxRetries) {
      const start = Date.now();
      let status: number | null = null;
      let responseBody: unknown;
      try {
        const init = this.buildInit(method, opts.body, opts.signal);
        const res = await fetch(url, init);
        status = res.status;
        const text = await res.text();
        responseBody = text ? safeJsonParse(text) : undefined;

        if (!res.ok) {
          const metaErr = (responseBody as MetaErrorResponse | undefined)
            ?.error;
          const isRetriable =
            RETRIABLE_HTTP.has(res.status) ||
            (metaErr ? RETRIABLE_META_CODES.has(metaErr.code) : false);

          if (isRetriable && attempt < this.cfg.maxRetries) {
            const delay = backoffMs(attempt, res.headers.get("retry-after"));
            await this.audit({
              method,
              path,
              status,
              durationMs: Date.now() - start,
              requestBody: redactBody(opts.body),
              responseExcerpt: excerpt(responseBody),
              error: metaErr?.message ?? `HTTP ${status}`,
              calledBy: opts.calledBy,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }

          await this.audit({
            method,
            path,
            status,
            durationMs: Date.now() - start,
            requestBody: redactBody(opts.body),
            responseExcerpt: excerpt(responseBody),
            error: metaErr?.message ?? `HTTP ${status}`,
            calledBy: opts.calledBy,
          });
          // Build a verbose message including subcode + user_msg so callers
          // (decision journal, dialog Errors list, etc.) can show the real
          // reason — `error.message` alone is often a generic "Invalid
          // parameter" with the actionable detail hidden in error_user_msg.
          const parts = [
            metaErr?.message ?? `Meta API HTTP ${status}`,
            metaErr?.error_subcode ? `(subcode ${metaErr.error_subcode})` : null,
            metaErr?.error_user_msg && metaErr.error_user_msg !== metaErr.message
              ? `— ${metaErr.error_user_msg}`
              : null,
          ].filter(Boolean);
          throw new MetaApiError(parts.join(" "), status, metaErr);
        }

        // Graph can return HTTP 200 with an `{ error: ... }` body (notably
        // some batch/edge endpoints). Treat it as a failure with the real
        // message instead of handing the error object back as data.
        const okErr = (responseBody as MetaErrorResponse | undefined)?.error;
        if (okErr) {
          await this.audit({
            method,
            path,
            status,
            durationMs: Date.now() - start,
            requestBody: redactBody(opts.body),
            responseExcerpt: excerpt(responseBody),
            error: okErr.message,
            calledBy: opts.calledBy,
          });
          throw new MetaApiError(okErr.message, status ?? 200, okErr);
        }

        await this.audit({
          method,
          path,
          status,
          durationMs: Date.now() - start,
          requestBody: redactBody(opts.body),
          responseExcerpt: excerpt(responseBody),
          calledBy: opts.calledBy,
        });
        return responseBody as T;
      } catch (err) {
        lastError = err;
        const networkRetry =
          !(err instanceof MetaApiError) && attempt < this.cfg.maxRetries;
        if (networkRetry) {
          await this.audit({
            method,
            path,
            status,
            durationMs: Date.now() - start,
            requestBody: redactBody(opts.body),
            error: err instanceof Error ? err.message : String(err),
            calledBy: opts.calledBy,
          });
          await sleep(backoffMs(attempt, null));
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error("MetaClient: exhausted retries");
  }

  /**
   * Fetch every page of a Meta list endpoint by following `paging.next` until
   * exhausted. Hard-capped at maxPages (default 50) to avoid infinite loops on
   * a misbehaving cursor — that's 25,000 records at limit=500.
   */
  async requestPaged<T>(
    path: string,
    opts: RequestOptions = {},
    maxPages = 50,
  ): Promise<{ data: T[]; pagesFetched: number }> {
    const all: T[] = [];
    let pagesFetched = 0;
    // Initial request goes through normal request() with the configured query.
    let page = await this.request<{ data: T[]; paging?: { next?: string } }>(
      path,
      opts,
    );
    pagesFetched += 1;
    if (Array.isArray(page.data)) all.push(...page.data);

    while (page.paging?.next && pagesFetched < maxPages) {
      // paging.next is a fully-formed URL — bypass buildUrl and fetch directly,
      // but reuse retry + audit by going through request() with an empty
      // pre-built path. Easiest: just fetch the absolute URL.
      // Meta's paging.next URLs already include the access_token query param,
      // so a vanilla GET fetch is sufficient.
      const init = this.buildInit("GET", undefined);
      const res = await fetch(page.paging.next, init);
      if (!res.ok) break;
      const text = await res.text();
      page = (text ? JSON.parse(text) : { data: [] }) as {
        data: T[];
        paging?: { next?: string };
      };
      pagesFetched += 1;
      if (Array.isArray(page.data)) all.push(...page.data);
    }
    return { data: all, pagesFetched };
  }

  // ─── Convenience endpoints (extend per-phase) ────────────────────────────

  me(fields?: string[]): Promise<MetaUser> {
    return this.request<MetaUser>("/me", {
      query: { fields: fields?.join(",") ?? "id,name" },
    });
  }

  // Paged: Graph defaults to 25 results and an agency user's 26th+ asset
  // would silently vanish; requestPaged follows paging.next to exhaustion.
  async listAdAccounts(): Promise<MetaList<MetaAdAccount>> {
    const { data } = await this.requestPaged<MetaAdAccount>("/me/adaccounts", {
      query: {
        fields: "id,account_id,name,currency,timezone_name,business",
        limit: 100,
      },
    });
    return { data };
  }

  getAdAccountStatus(
    metaAccountId: string,
  ): Promise<{ account_status: number; disable_reason?: number; name: string }> {
    return this.request(`/${metaAccountId}`, {
      query: { fields: "account_status,disable_reason,name" },
      calledBy: "getAdAccountStatus",
    });
  }

  async listPages(): Promise<MetaList<MetaPage>> {
    const { data } = await this.requestPaged<MetaPage>("/me/accounts", {
      query: { fields: "id,name,access_token,category,tasks", limit: 100 },
    });
    return { data };
  }

  igUserForPage(pageId: string): Promise<{ instagram_business_account?: MetaIgUser }> {
    return this.request(`/${pageId}`, {
      query: { fields: "instagram_business_account{id,username}" },
    });
  }

  /**
   * List the most recent organic posts published to a Page.
   *
   * `/{page_id}/published_posts` returns only posts the page itself published
   * (excludes scheduled drafts, dark posts, and posts other users tagged the
   * page in). Each post may include an `attachments` block describing the
   * media — the page-post-watch cron uses this to classify a post as a
   * regular FB-page post, a Reel, or an IG-native cross-post.
   *
   * Requires a PAGE access token, not the user token. Caller is responsible
   * for instantiating MetaClient with the decrypted page token.
   */
  listPagePublishedPosts(
    pageId: string,
    opts?: { limit?: number; calledBy?: string },
  ): Promise<
    MetaList<{
      id: string;
      created_time: string;
      message?: string;
      permalink_url?: string;
      // `full_picture` is the post's thumbnail; feeds the boost-flow CTA
      // rebuild. The `object_id` field is also documented on /post but
      // Meta v3.3+ rejects it on /{page}/published_posts with
      //   (#12) deprecate_post_aggregated_fields_for_attachement
      // so we omit it. Callers that need the underlying video id should
      // pull it from attachments.target.id.
      full_picture?: string;
      attachments?: {
        data?: Array<{
          type?: string;
          media_type?: string;
          unshimmed_url?: string;
          target?: { id?: string; url?: string };
          media?: { image?: { src?: string } };
          subattachments?: { data?: Array<{ type?: string; media_type?: string }> };
        }>;
      };
    }>
  > {
    return this.request(`/${pageId}/published_posts`, {
      query: {
        // Meta v3.3+ rejects `object_id` (and `attachments.url`) on
        // /{page}/published_posts with
        //   (#12) deprecate_post_aggregated_fields_for_attachement
        // — both omitted. Use `attachments.target.id` for the underlying
        // video id, `attachments.unshimmed_url` for the post URL, and
        // `attachments.media.image.src` for thumbnails. `full_picture`
        // still works as a top-level field.
        fields:
          "id,created_time,message,permalink_url,full_picture,attachments{type,media_type,unshimmed_url,target,media{image{src}},subattachments}",
        limit: opts?.limit ?? 10,
      },
      calledBy: opts?.calledBy ?? "listPagePublishedPosts",
    });
  }

  /**
   * List all campaigns in an ad account, paginated. Account-wide sync feeds
   * the campaigns / ad sets / ads tabs, so missing entries here cascade into
   * empty rows everywhere else. Includes ARCHIVED + PAUSED + DELETED via
   * explicit effective_status filter.
   */
  async listCampaigns(adAccountId: string): Promise<MetaList<MetaCampaign>> {
    const { data } = await this.requestPaged<MetaCampaign>(
      `/${adAccountId}/campaigns`,
      {
        query: {
          fields:
            "id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy",
          limit: 500,
          effective_status: ALL_CAMPAIGN_STATUSES,
        },
        calledBy: "listCampaigns",
      },
    );
    return { data };
  }

  /** Fetch a single campaign's details — used to read bid_strategy upfront. */
  getCampaignDetails(
    campaignMetaId: string,
    calledBy?: string,
  ): Promise<MetaCampaign> {
    return this.request(`/${campaignMetaId}`, {
      query: {
        fields:
          "id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories,buying_type",
      },
      calledBy: calledBy ?? "getCampaignDetails",
    });
  }

  /**
   * Create a new campaign in `adAccountMetaId` (must include `act_` prefix).
   * Used when cloning an ad set into an ad account that has no campaigns yet —
   * we mirror the source campaign's objective/special_ad_categories/buying_type
   * and force status=PAUSED so nothing goes live without operator review.
   */
  createCampaign(
    adAccountMetaId: string,
    fields: {
      name: string;
      objective: string;
      special_ad_categories?: string[];
      buying_type?: string;
      daily_budget?: number;
      lifetime_budget?: number;
      bid_strategy?: string;
    },
    calledBy?: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      name: fields.name,
      objective: fields.objective,
      status: "PAUSED",
      special_ad_categories: fields.special_ad_categories ?? [],
    };
    if (fields.buying_type) body.buying_type = fields.buying_type;
    if (fields.daily_budget != null) body.daily_budget = fields.daily_budget;
    if (fields.lifetime_budget != null) body.lifetime_budget = fields.lifetime_budget;
    if (fields.bid_strategy) body.bid_strategy = fields.bid_strategy;
    // Meta rejects ABO campaign creation (no campaign budget) unless this flag
    // is set explicitly (error subcode 4834011). When we DO pass a campaign
    // budget it's CBO and the flag is irrelevant, so only default it for the
    // no-budget (ABO) case — false means ad sets keep their own full budgets.
    if (fields.daily_budget == null && fields.lifetime_budget == null) {
      body.is_adset_budget_sharing_enabled = false;
    }
    return this.request(`/${adAccountMetaId}/campaigns`, {
      method: "POST",
      body,
      calledBy: calledBy ?? "createCampaign",
    });
  }

  /** All ad sets in an ad account, paginated + non-terminal status filter. */
  async listAdSets(adAccountId: string): Promise<MetaList<MetaAdSet>> {
    const { data } = await this.requestPaged<MetaAdSet>(
      `/${adAccountId}/adsets`,
      {
        query: {
          fields:
            "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_amount,targeting,created_time",
          limit: 500,
          effective_status: ALL_ADSET_STATUSES,
        },
        calledBy: "listAdSets",
      },
    );
    return { data };
  }

  /**
   * Batch-fetch ad creatives by ID using Meta's `GET /?ids=<csv>&fields=...`
   * multi-node read. Returns a map keyed by creative ID — Meta omits IDs
   * the token can't see, so callers must handle missing entries.
   *
   * Use this over `/{ad_account}/adcreatives` for any sync path that
   * already knows which creatives it needs (extract IDs from `listAds`).
   * The account-wide endpoint returns every creative ever uploaded — for
   * mature accounts that's thousands of rows and the response routinely
   * trips Meta's "reduce the amount of data" guard. This endpoint costs
   * exactly what you ask for.
   *
   * IDs are auto-chunked at 50 per request (Meta's documented cap). Each
   * chunk goes through `request()` so the audit log captures it.
   */
  async getCreativesBatch(
    creativeIds: string[],
    opts?: { calledBy?: string },
  ): Promise<
    Map<
      string,
      {
        id: string;
        name?: string;
        title?: string;
        body?: string;
        image_url?: string;
        thumbnail_url?: string;
        video_id?: string;
        object_story_spec?: Record<string, unknown>;
        asset_feed_spec?: Record<string, unknown>;
      }
    >
  > {
    type CreativeNode = {
      id: string;
      name?: string;
      title?: string;
      body?: string;
      image_url?: string;
      thumbnail_url?: string;
      video_id?: string;
      object_story_spec?: Record<string, unknown>;
      asset_feed_spec?: Record<string, unknown>;
    };
    const out = new Map<string, CreativeNode>();
    const fields =
      "id,name,title,body,image_url,thumbnail_url,video_id,object_story_spec,asset_feed_spec";
    // Meta's default thumbnail_url is a blurry 64×64. thumbnail_width/height
    // are read-params on the AdCreative node — ask for 600px so video cards
    // (whose only still is thumbnail_url) render sharp. Image ads also carry
    // a full-res image_url, which the UI prefers over this.
    const thumbSize = 600;
    const chunkSize = 50;
    // Deduplicate IDs before batching — same creative may back many ads.
    const unique = Array.from(new Set(creativeIds.filter(Boolean)));
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const res = await this.request<Record<string, CreativeNode>>("/", {
        query: {
          ids: chunk.join(","),
          fields,
          thumbnail_width: thumbSize,
          thumbnail_height: thumbSize,
        },
        calledBy: opts?.calledBy ?? "getCreativesBatch",
      });
      for (const [k, v] of Object.entries(res)) {
        if (v && typeof v === "object" && "id" in v) {
          out.set(k, v);
        }
      }
    }
    return out;
  }

  /** All ads in an ad account, paginated + non-terminal status filter.
   *
   * `created_time` was added 2026-05-22 for the Foreplay-style /creatives
   * view: "days running" badge, timeline launch-date grouping, and the
   * Lens "New Launched (last 7d)" counter all rely on it.
   */
  async listAds(adAccountId: string): Promise<MetaList<MetaAd>> {
    const { data } = await this.requestPaged<MetaAd>(
      `/${adAccountId}/ads`,
      {
        query: {
          fields:
            "id,name,adset_id,status,effective_status,creative,created_time",
          limit: 500,
          effective_status: ALL_AD_STATUSES,
        },
        calledBy: "listAds",
      },
    );
    return { data };
  }

  /**
   * Count currently-delivering ads under a single campaign — uses Meta's
   * filtering + `summary=total_count` so no pagination of the actual rows
   * is needed. ~200ms per call vs. ~14s+ for listAds on a heavy account.
   *
   * Introduced 2026-05-31 for the AI Guard's Meta-side verification (was
   * trusting our local `ads.effective_status` column, which silently
   * drifted from Meta for 3 days during the AIA Newspaper incident — DB
   * said 10 active while Meta UI had 2). The Guard now calls this per
   * campaign on each guard wave and uses Meta's truth for the
   * `>= TARGET_ACTIVE_ADS` decision, falling back to the DB count only if
   * the Meta call fails.
   */
  async countActiveAdsForCampaign(opts: {
    adAccountId: string;
    campaignMetaId: string;
  }): Promise<number> {
    const filtering = JSON.stringify([
      {
        field: "campaign.id",
        operator: "EQUAL",
        value: opts.campaignMetaId,
      },
      {
        field: "effective_status",
        operator: "IN",
        value: ["ACTIVE"],
      },
    ]);
    const res = await this.request<{
      data: unknown[];
      summary?: { total_count?: number };
    }>(`/${opts.adAccountId}/ads`, {
      query: {
        filtering,
        summary: "total_count",
        fields: "id",
        limit: 1,
      },
      calledBy: "countActiveAdsForCampaign",
    });
    return res.summary?.total_count ?? 0;
  }

  getAdSetDetails(adSetMetaId: string, calledBy?: string): Promise<MetaAdSet> {
    return this.request(`/${adSetMetaId}`, {
      query: {
        fields:
          "id,name,campaign_id,account_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,bid_amount,bid_constraints,targeting,promoted_object",
      },
      calledBy: calledBy ?? "getAdSetDetails",
    });
  }

  /**
   * List all ad sets in a campaign, paginating through `paging.next` so
   * campaigns with > 500 ad sets return complete results.
   *
   * Note: we do NOT pass effective_status here. The /{campaign_id}/adsets
   * endpoint rejects some statuses that /{account}/adsets accepts ("Invalid
   * parameter"), and the default behaviour (ACTIVE + PAUSED) is exactly what
   * the sync dialog and reference scanner need.
   */
  async listAdSetsForCampaign(campaignMetaId: string): Promise<MetaList<MetaAdSet>> {
    const { data } = await this.requestPaged<MetaAdSet>(
      `/${campaignMetaId}/adsets`,
      {
        query: {
          fields: "id,name,campaign_id,status,effective_status",
          limit: 500,
        },
        calledBy: "listAdSetsForCampaign",
      },
    );
    return { data };
  }

  /**
   * List all ads in an ad set, paginating through `paging.next` so ad sets
   * with > 500 ads return complete results.
   */
  async listAdsForAdSet(adSetMetaId: string): Promise<MetaList<MetaAd>> {
    const { data } = await this.requestPaged<MetaAd>(
      `/${adSetMetaId}/ads`,
      {
        query: {
          fields: "id,name,adset_id,status,effective_status,creative,created_time",
          limit: 500,
        },
        calledBy: "listAdsForAdSet",
      },
    );
    return { data };
  }

  // ─── Public Ad Library (/ads_archive) ────────────────────────────────────

  /**
   * Search the public Meta Ad Library. Powers /creatives/brands and
   * /creatives/discover. Requires `ads_read` on the user's access token
   * (already granted for /insights). Note: returns currently-active ads
   * only when `ad_active_status === 'ACTIVE'`. Historical ads (ended) are
   * not exposed via this endpoint.
   *
   * `ad_reached_countries` is mandatory per Meta — defaults to ['MY'] to
   * match Andi's market. Caller can override.
   *
   * Audit: every call lands in `meta_api_calls` via the standard
   * `request()` wrapper.
   */
  async searchAdLibrary(opts: {
    searchTerms?: string;
    searchPageIds?: string[];
    countries?: string[]; // ISO 3166-1 alpha-2
    activeStatus?: "ACTIVE" | "ALL" | "INACTIVE";
    /** Uppercase enums, e.g. ["INSTAGRAM"]. Omit for all platforms. */
    publisherPlatforms?: string[];
    /** ISO 639-1 codes, e.g. ["en", "ms"]. Omit for any language. */
    languages?: string[];
    /** "all" | "video" | "image" | "meme" | "image_and_meme" | "none". */
    mediaType?: string;
    /** YYYY-MM-DD. Filters on ad_delivery_start_time / _stop_time. */
    deliveryDateMin?: string;
    deliveryDateMax?: string;
    limit?: number;
    calledBy?: string;
  }): Promise<MetaList<MetaAdLibraryAd>> {
    if (!opts.searchTerms && (!opts.searchPageIds || opts.searchPageIds.length === 0)) {
      throw new Error(
        "searchAdLibrary requires either searchTerms or searchPageIds",
      );
    }
    const countries = opts.countries?.length ? opts.countries : ["MY"];
    const limit = Math.min(opts.limit ?? 50, 100);

    const query: Record<string, string | number | undefined> = {
      ad_reached_countries: JSON.stringify(countries),
      ad_active_status: opts.activeStatus ?? "ACTIVE",
      ad_type: "ALL",
      limit,
      // Field selection. The Ad Library schema is intentionally narrow —
      // creative bodies/titles/descriptions are arrays (Meta serves
      // multi-creative ads as a single archive row), snapshot_url is
      // a static screenshot, and there is no spend/results in
      // /ads_archive for non-political ads.
      fields:
        "id,page_id,page_name,ad_creative_bodies,ad_creative_link_captions," +
        "ad_creative_link_titles,ad_creative_link_descriptions,ad_snapshot_url," +
        "ad_delivery_start_time,ad_delivery_stop_time,languages," +
        "publisher_platforms,target_locations",
    };
    if (opts.searchTerms) query.search_terms = opts.searchTerms;
    if (opts.searchPageIds?.length) {
      query.search_page_ids = JSON.stringify(opts.searchPageIds);
    }
    if (opts.publisherPlatforms?.length) {
      query.publisher_platforms = JSON.stringify(opts.publisherPlatforms);
    }
    if (opts.languages?.length) {
      query.languages = JSON.stringify(opts.languages);
    }
    if (opts.mediaType && opts.mediaType !== "all") {
      query.media_type = opts.mediaType;
    }
    if (opts.deliveryDateMin) query.ad_delivery_date_min = opts.deliveryDateMin;
    if (opts.deliveryDateMax) query.ad_delivery_date_max = opts.deliveryDateMax;

    // Note: `/ads_archive` lives at the root, not under any account.
    const page = await this.request<{
      data: MetaAdLibraryAd[];
      paging?: { next?: string };
    }>("/ads_archive", {
      query,
      calledBy: opts.calledBy ?? "searchAdLibrary",
    });
    return { data: page.data ?? [] };
  }

  async insights(
    entityId: string,
    opts: {
      level: "account" | "campaign" | "adset" | "ad";
      datePreset?: string; // 'today' | 'yesterday' | 'last_7d' | …
      timeRange?: { since: string; until: string };
      breakdowns?: string[];
      fields?: string[];
    },
  ): Promise<MetaList<MetaInsightsRow>> {
    // Paginate via paging.next so accounts with > 500 (ad × day) rows return
    // every day in the window. Without this, last_7d on a 250-ad account caps
    // at the first 500 rows — typically days 1-3 of the range — and silently
    // drops days 4-7 from the brief.
    // time_increment=1 forces one row per ad per day; without it Meta collapses
    // the range into a single row stamped with date_start = window start.
    const { data } = await this.requestPaged<MetaInsightsRow>(
      `/${entityId}/insights`,
      {
        query: {
          level: opts.level,
          date_preset: opts.datePreset,
          time_range: opts.timeRange ? JSON.stringify(opts.timeRange) : undefined,
          time_increment: 1,
          breakdowns: opts.breakdowns?.join(","),
          fields:
            opts.fields?.join(",") ??
            "impressions,reach,spend,clicks,ctr,cpm,cpc,actions,cost_per_action_type,purchase_roas",
          limit: 500,
        },
        calledBy: "insights",
      },
    );
    return { data };
  }

  // ─── Writes ──────────────────────────────────────────────────────────────

  /** Update an ad's status. Pass "PAUSED" or "ACTIVE". */
  setAdStatus(metaAdId: string, status: "ACTIVE" | "PAUSED", calledBy?: string): Promise<{ success: boolean }> {
    return this.request(`/${metaAdId}`, {
      method: "POST",
      body: { status },
      calledBy,
    });
  }

  setAdSetStatus(
    metaAdSetId: string,
    status: "ACTIVE" | "PAUSED",
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${metaAdSetId}`, {
      method: "POST",
      body: { status },
      calledBy,
    });
  }

  /**
   * Update an ad set's daily or lifetime budget. Pass amounts in MINOR units
   * (e.g., RM12.50 = 1250). Pass exactly one of daily_budget / lifetime_budget.
   */
  setAdSetBudget(
    metaAdSetId: string,
    body:
      | { daily_budget: number }
      | { lifetime_budget: number },
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${metaAdSetId}`, {
      method: "POST",
      body,
      calledBy,
    });
  }

  setCampaignStatus(
    metaCampaignId: string,
    status: "ACTIVE" | "PAUSED",
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${metaCampaignId}`, {
      method: "POST",
      body: { status },
      calledBy,
    });
  }

  /**
   * Update a campaign's daily or lifetime budget. Pass amounts in MINOR units
   * (e.g., RM12.50 = 1250). Pass exactly one of daily_budget / lifetime_budget.
   */
  setCampaignBudget(
    metaCampaignId: string,
    body: { daily_budget: number } | { lifetime_budget: number },
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${metaCampaignId}`, {
      method: "POST",
      body,
      calledBy,
    });
  }

  /** Create an ad creative under an ad account. */
  createAdCreative(
    adAccountId: string,
    body: Record<string, unknown>,
    calledBy?: string,
  ): Promise<{ id: string }> {
    return this.request(`/${adAccountId}/adcreatives`, {
      method: "POST",
      body,
      calledBy,
    });
  }

  /** Create an ad. Required: name, adset_id, creative={creative_id}, status. */
  createAd(
    adAccountId: string,
    body: Record<string, unknown>,
    calledBy?: string,
  ): Promise<{ id: string }> {
    return this.request(`/${adAccountId}/ads`, {
      method: "POST",
      body,
      calledBy,
    });
  }

  /** Fetch full creative details (object_story_id, spec, copy fields).
   *
   * Returns BOTH `object_story_id` (set explicitly when the creative was built
   * from a page post) and `effective_object_story_id` (Meta computes this for
   * any creative including ones built from raw assets). Callers should prefer
   * `object_story_id ?? effective_object_story_id` when copying creatives —
   * many ads have only the effective version. */
  getCreativeDetails(
    creativeId: string,
    calledBy?: string,
  ): Promise<{
    id: string;
    name?: string;
    object_story_id?: string;
    effective_object_story_id?: string;
    object_story_spec?: Record<string, unknown>;
    body?: string;
    title?: string;
    image_url?: string;
    asset_feed_spec?: Record<string, unknown>;
    degrees_of_freedom_spec?: Record<string, unknown>;
    contextual_multi_ads?: Record<string, unknown>;
    /** Public IG permalink (e.g. https://www.instagram.com/p/<shortcode>).
     * Preferred input field on createAdCreative when cloning an IG-native
     * ad — Meta resolves it back to the same IG media. */
    instagram_permalink_url?: string;
    /** Graph API ID for the IG media tied to this creative (16-digit, e.g.
     * "1758761623826495"). This is the FB-side reference. The Instagram-side
     * legacy ID that Ads Manager's "Search by ID" picker matches against is
     * a *different* number — fetch it via {@link getIgMediaInfo} when needed. */
    effective_instagram_media_id?: string;
    /** Original IG media ID the creative was built from. This is the
     * operator-facing ID that Ads Manager displays under "Instagram post" in
     * the post picker and accepts in the "Enter post ID" field. Distinct from
     * `effective_instagram_media_id` (the resolved Graph reference) and from
     * the legacy `ig_id` returned by {@link getIgMediaInfo}. */
    source_instagram_media_id?: string;
    /** IG account ID that owns the source IG media. */
    instagram_user_id?: string;
  }> {
    return this.request(`/${creativeId}`, {
      query: {
        fields:
          "id,name,object_story_id,effective_object_story_id,object_story_spec,body,title,image_url,asset_feed_spec,degrees_of_freedom_spec,contextual_multi_ads,instagram_permalink_url,effective_instagram_media_id,source_instagram_media_id,instagram_user_id",
      },
      calledBy,
    });
  }

  /** Fetch the IG media node for an `effective_instagram_media_id`. Returns
   * the FB-side Graph ID (`id`), the Instagram-side legacy ID (`ig_id`), and
   * the public permalink. The two numeric IDs are distinct: `id` is the
   * 16-digit Graph reference, `ig_id` is the 17-18-digit number Ads Manager's
   * "Edit Ad → Select Post → Instagram → Search by ID" picker uses. */
  getIgMediaInfo(
    igMediaId: string,
    calledBy?: string,
  ): Promise<{
    id: string;
    ig_id?: string;
    permalink?: string;
  }> {
    return this.request(`/${igMediaId}`, {
      query: { fields: "id,ig_id,permalink" },
      calledBy,
    });
  }

  /** Permanently delete an ad. */
  deleteAd(adId: string, calledBy?: string): Promise<{ success: boolean }> {
    return this.request(`/${adId}`, { method: "DELETE", calledBy });
  }

  /**
   * Duplicate an ad via Meta's native /{ad_id}/copies endpoint. Reuses the
   * source creative as-is, so all creative-level settings (Multi-advertiser
   * ads, Advantage+ destination, browser add-ons, asset_feed_spec captions,
   * degrees_of_freedom_spec) are preserved automatically — no createAdCreative
   * call needed, so the (#3) "Application does not have the capability" error
   * is bypassed entirely.
   *
   * Constraint: source ad and destination ad set MUST be in the same ad
   * account (Meta creatives are account-scoped). For cross-account copies,
   * use the createAdCreative path instead.
   */
  copyAd(
    adMetaId: string,
    opts: {
      /** Target ad set. If omitted, copies into the source's own ad set. */
      adsetId?: string;
      statusOption?: "ACTIVE" | "PAUSED" | "INHERITED_FROM_SOURCE";
      /** Optional rename strategy. Meta will otherwise suffix " - Copy". */
      renameOptions?: {
        rename_strategy?:
          | "NO_RENAME"
          | "ONLY_TOP_LEVEL_RENAME"
          | "DEEP_RENAME";
        rename_prefix?: string;
        rename_suffix?: string;
      };
    },
    calledBy?: string,
  ): Promise<{
    copied_ad_id?: string;
    ad_object_ids?: Array<{
      ad_object_type: string;
      source_id: string;
      copied_id: string;
    }>;
  }> {
    const body: Record<string, unknown> = {};
    if (opts.adsetId) body.adset_id = opts.adsetId;
    body.status_option = opts.statusOption ?? "PAUSED";
    if (opts.renameOptions) body.rename_options = opts.renameOptions;
    return this.request(`/${adMetaId}/copies`, {
      method: "POST",
      body,
      calledBy: calledBy ?? "copyAd",
    });
  }

  /** Update one or more fields on an ad (e.g. rename). */
  updateAd(
    adMetaId: string,
    fields: Record<string, unknown>,
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${adMetaId}`, {
      method: "POST",
      body: fields,
      calledBy: calledBy ?? "updateAd",
    });
  }

  /** Permanently delete an ad creative. */
  deleteAdCreative(
    creativeId: string,
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${creativeId}`, { method: "DELETE", calledBy });
  }

  /** Create an ad set. */
  createAdSet(
    adAccountId: string,
    body: Record<string, unknown>,
    calledBy?: string,
  ): Promise<{ id: string }> {
    return this.request(`/${adAccountId}/adsets`, {
      method: "POST",
      body,
      calledBy,
    });
  }

  /**
   * Duplicate an ad set via Meta's native /copies endpoint. The destination
   * campaign can differ from the source's. Most reliable way to create a new
   * ad set in a campaign because Meta itself handles all internal validation
   * and bid_strategy compatibility.
   */
  copyAdSet(
    adSetMetaId: string,
    opts: {
      campaignId?: string;
      deepCopy?: boolean;
      statusOption?: "ACTIVE" | "PAUSED" | "INHERITED_FROM_SOURCE";
    },
    calledBy?: string,
  ): Promise<{ copied_adset_id: string; ad_object_ids?: Array<{ ad_object_type: string; source_id: string; copied_id: string }> }> {
    const body: Record<string, unknown> = {};
    if (opts.campaignId) body.campaign_id = opts.campaignId;
    body.deep_copy = opts.deepCopy ?? false;
    body.status_option = opts.statusOption ?? "PAUSED";
    return this.request(`/${adSetMetaId}/copies`, {
      method: "POST",
      body,
      calledBy: calledBy ?? "copyAdSet",
    });
  }

  /** Update one or more fields on an ad set (e.g. rename). */
  updateAdSet(
    adSetMetaId: string,
    fields: Record<string, unknown>,
    calledBy?: string,
  ): Promise<{ success: boolean }> {
    return this.request(`/${adSetMetaId}`, {
      method: "POST",
      body: fields,
      calledBy: calledBy ?? "updateAdSet",
    });
  }

  /**
   * Upload an image to an ad account's image library and return its image_hash
   * — the value the creative spec needs in `link_data.image_hash`.
   *
   * Fetches the image bytes from `imageUrl` server-side, then POSTs multipart
   * to /act_xxx/adimages. Meta accepts JPG/PNG; ~10 MB cap (varies).
   */
  async uploadAdImage(opts: {
    adAccountId: string; // act_xxx
    imageUrl: string;
    filename?: string;
    calledBy?: string;
  }): Promise<{ hash: string; url?: string }> {
    const filename = opts.filename ?? `creative-${Date.now()}.jpg`;

    // Fetch the image from its public URL.
    const res = await fetch(opts.imageUrl);
    if (!res.ok) {
      throw new Error(
        `Could not fetch image at ${opts.imageUrl} (${res.status})`,
      );
    }
    const blob = await res.blob();

    // Multipart POST. We don't go through this.request() because adimages
    // wants the access_token as a form field for multipart uploads.
    const fd = new FormData();
    fd.append("access_token", this.cfg.accessToken);
    fd.append("source", blob, filename);

    const url = `${this.cfg.baseUrl}/${opts.adAccountId}/adimages`;
    const start = Date.now();
    let status: number | null = null;
    let parsed: unknown;
    try {
      const r = await fetch(url, { method: "POST", body: fd });
      status = r.status;
      const text = await r.text();
      parsed = text ? safeJsonParseLocal(text) : undefined;
      if (!r.ok) {
        const metaErr = (parsed as MetaErrorResponse | undefined)?.error;
        await this.audit({
          method: "POST",
          path: `/${opts.adAccountId}/adimages`,
          status,
          durationMs: Date.now() - start,
          requestBody: { source: `[blob ${blob.size} bytes ${blob.type}]`, filename },
          responseExcerpt: parsed,
          error: metaErr?.message ?? `HTTP ${status}`,
          calledBy: opts.calledBy,
        });
        throw new MetaApiError(
          metaErr?.message ?? `Image upload HTTP ${status}`,
          status,
          metaErr,
        );
      }
      await this.audit({
        method: "POST",
        path: `/${opts.adAccountId}/adimages`,
        status,
        durationMs: Date.now() - start,
        requestBody: { filename, sourceBytes: blob.size },
        responseExcerpt: parsed,
        calledBy: opts.calledBy,
      });
      const data = parsed as {
        images?: Record<string, { hash: string; url?: string }>;
      };
      const first = data.images ? Object.values(data.images)[0] : null;
      if (!first?.hash) {
        throw new Error("Meta returned no image_hash");
      }
      return { hash: first.hash, url: first.url };
    } catch (err) {
      if (err instanceof MetaApiError) throw err;
      throw new Error(
        `uploadAdImage failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Upload a video to an ad account by public URL. Meta fetches the bytes
   * itself (`file_url`), so the video never transits our server — the returned
   * id is immediately valid but the video processes asynchronously; poll
   * getVideoStatus until `ready` before referencing it in a creative.
   */
  uploadAdVideo(opts: {
    adAccountId: string; // act_xxx
    fileUrl: string;
    name?: string;
    calledBy?: string;
  }): Promise<{ id: string }> {
    return this.request(`/${opts.adAccountId}/advideos`, {
      method: "POST",
      body: {
        file_url: opts.fileUrl,
        ...(opts.name ? { name: opts.name } : {}),
      },
      calledBy: opts.calledBy ?? "uploadAdVideo",
    });
  }

  /** Processing state of an uploaded ad video. */
  getVideoStatus(
    videoId: string,
    calledBy?: string,
  ): Promise<{
    status?: {
      video_status?: "ready" | "processing" | "error";
      processing_progress?: number;
    };
  }> {
    return this.request(`/${videoId}`, {
      query: { fields: "status" },
      calledBy: calledBy ?? "getVideoStatus",
    });
  }

  /** Auto-generated thumbnails for an uploaded ad video (available once ready). */
  listVideoThumbnails(
    videoId: string,
    calledBy?: string,
  ): Promise<{ data?: Array<{ uri: string; is_preferred?: boolean }> }> {
    return this.request(`/${videoId}/thumbnails`, {
      calledBy: calledBy ?? "listVideoThumbnails",
    });
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildUrl(
    path: string,
    query?: RequestOptions["query"],
  ): string {
    const url = new URL(`${this.cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    url.searchParams.set("access_token", this.cfg.accessToken);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private buildInit(
    method: Method,
    body: RequestOptions["body"],
    signal?: AbortSignal,
  ): RequestInit {
    const init: RequestInit = { method, signal };
    if (body !== undefined) {
      if (body instanceof FormData) {
        init.body = body;
      } else {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
    }
    return init;
  }

  private async audit(entry: AuditEntry): Promise<void> {
    if (!this.cfg.audit) return;
    try {
      await this.cfg.audit.record(entry);
    } catch {
      // Audit failures must not break the request flow.
    }
  }

  /**
   * Switch the audit log into buffered mode. Subsequent `record()` calls
   * accumulate in memory; nothing lands in `meta_api_calls` until the
   * matching `flushAudit()` runs. Pair with try/finally so a thrown error
   * inside the batched region still flushes.
   */
  beginAuditBatch(): void {
    this.cfg.audit?.beginBatch?.();
  }

  /**
   * Drain any buffered audit entries to `meta_api_calls` in one bulk INSERT
   * and return the auditor to immediate-write mode. Safe to call when no
   * batch is active; it's a no-op.
   */
  async flushAudit(): Promise<void> {
    if (!this.cfg.audit?.flush) return;
    try {
      await this.cfg.audit.flush();
    } catch {
      // Same rule as record(): audit failures don't break the caller.
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 30_000);
  }
  // Exp backoff with jitter, capped at 30s.
  const base = Math.min(2 ** attempt * 250, 15_000);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Hoisted alias so the multipart upload helper above can reach it without
// pulling the top-level helper into class scope.
function safeJsonParseLocal(s: string): unknown {
  return safeJsonParse(s);
}

function redactBody(body: RequestOptions["body"]): unknown {
  if (!body) return undefined;
  if (body instanceof FormData) return "[FormData]";
  return body;
}

function excerpt(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  const s = JSON.stringify(body);
  if (s.length <= 4000) return body;
  return { _truncated: true, head: s.slice(0, 4000) };
}
