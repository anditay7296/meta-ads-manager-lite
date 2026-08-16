// Minimal Meta Marketing API types — extend as endpoints are wrapped.
// Reference: https://developers.facebook.com/docs/marketing-api/

export type MetaApiVersion = `v${number}.${number}`;

export const META_API_VERSION: MetaApiVersion = "v21.0";

export type MetaError = {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
};

export type MetaErrorResponse = {
  error: MetaError;
};

export type MetaPaging = {
  cursors?: { before?: string; after?: string };
  next?: string;
  previous?: string;
};

export type MetaList<T> = {
  data: T[];
  paging?: MetaPaging;
};

export type MetaUser = {
  id: string;
  name?: string;
};

export type MetaAdAccount = {
  id: string; // act_xxx
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  business?: { id: string; name?: string };
  /** 1=ACTIVE 2=DISABLED 3=UNSETTLED 7=PENDING_RISK_REVIEW 8=PENDING_SETTLEMENT 9=IN_GRACE_PERIOD 100=PENDING_CLOSURE 101=CLOSED */
  account_status?: number;
  disable_reason?: number;
};

export type MetaPage = {
  id: string;
  name: string;
  access_token?: string;
  category?: string;
  tasks?: string[];
};

export type MetaIgUser = {
  id: string;
  username?: string;
};

export type MetaCampaign = {
  id: string;
  name: string;
  objective?: string;
  status: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  /**
   * LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP,
   * LOWEST_COST_WITH_MIN_ROAS — when set on the campaign, every child ad set
   * must comply (e.g. provide bid_constraints.roas_average_floor for ROAS).
   */
  bid_strategy?: string;
  special_ad_categories?: string[];
  buying_type?: string;
};

export type MetaAdSet = {
  id: string;
  name: string;
  campaign_id: string;
  account_id?: string; // numeric account id (no `act_` prefix)
  status: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  /** Ad-set-level bid strategy (ABO campaigns — campaign-level CBO carries it
   * on MetaCampaign instead). Omitting it on createAdSet in an ABO campaign
   * can make Meta demand bid_amount (subcode 2490487). */
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: unknown; // e.g. { roas_average_floor: 100 } for VALUE/ROAS goal
  targeting?: unknown;
  promoted_object?: unknown;
  /** ISO 8601 datetime. Returned by /{ad_account}/adsets when `created_time`
   * is in the requested `fields` list. */
  created_time?: string;
};

export type MetaAd = {
  id: string;
  name: string;
  adset_id: string;
  status: string;
  effective_status?: string;
  creative?: { id: string };
  /** ISO 8601 datetime string. Returned by /ads and /{adset_id}/ads when
   * `created_time` is in the requested `fields` list. */
  created_time?: string;
};

/**
 * One row of the public Meta Ad Library (`/ads_archive`). Schema differs
 * substantially from the regular /ads endpoint — there's no spend, no
 * results, and creative bodies / titles / descriptions are arrays
 * (multi-creative ads ship as a single archive_id with multiple bodies).
 *
 * Note: only currently-active ads are returned when querying with
 * `ad_active_status=ACTIVE`. Historical ads that have ended aren't
 * exposed via this endpoint.
 */
export type MetaAdLibraryAd = {
  /** Meta calls this the `archive_id`. */
  id: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_creative_link_captions?: string[];
  /** A static screenshot URL hosted by Meta. Same lifetime as the ad. */
  ad_snapshot_url?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  languages?: string[];
  publisher_platforms?: string[];
  target_locations?: Array<{ name: string; type?: string }>;
};

export type MetaInsightsRow = {
  date_start: string;
  date_stop: string;
  impressions?: string;
  reach?: string;
  spend?: string;
  clicks?: string;
  ctr?: string;
  cpm?: string;
  cpc?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  purchase_roas?: Array<{ action_type: string; value: string }>;
};

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly metaError?: MetaError,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}
