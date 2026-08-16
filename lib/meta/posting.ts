import { db, schema } from "@/lib/db/client";
import { and, eq } from "drizzle-orm";
import { decryptToken } from "@/lib/crypto/tokens";
import { MetaClient } from "@/lib/meta/client";

/**
 * Phase 4 MVP: image-only cross-post to a Facebook Page and (optionally) the
 * linked Instagram business account.
 *
 * Notes for follow-ups:
 * - Video / reels / stories use different Meta endpoints — wire per-media-kind.
 * - File upload (vs a public URL): IG strictly requires a publicly-reachable
 *   URL, so any file-upload path must go through Supabase Storage first to
 *   produce a public URL.
 */

export type PageHandle = {
  pageId: string; // local UUID
  metaPageId: string;
  pageAccessToken: string; // decrypted
  name: string;
};

export type IgHandle = {
  igAccountId: string; // local UUID
  metaIgUserId: string;
  username: string | null;
};

export async function loadPageHandle(opts: {
  orgId: string;
  pageId: string; // local uuid
}): Promise<PageHandle | null> {
  const [row] = await db
    .select({
      id: schema.pages.id,
      metaPageId: schema.pages.metaPageId,
      name: schema.pages.name,
      pageAccessTokenEncrypted: schema.pages.pageAccessTokenEncrypted,
    })
    .from(schema.pages)
    .where(
      and(eq(schema.pages.orgId, opts.orgId), eq(schema.pages.id, opts.pageId)),
    )
    .limit(1);
  if (!row) return null;
  if (!row.pageAccessTokenEncrypted) {
    throw new Error(
      `Page ${row.name} has no cached page access token — reconnect Meta to refresh.`,
    );
  }
  return {
    pageId: row.id,
    metaPageId: row.metaPageId,
    pageAccessToken: decryptToken(row.pageAccessTokenEncrypted),
    name: row.name,
  };
}

export async function loadIgForPage(opts: {
  orgId: string;
  pageId: string; // local uuid
}): Promise<IgHandle | null> {
  const [row] = await db
    .select({
      id: schema.igAccounts.id,
      metaIgUserId: schema.igAccounts.metaIgUserId,
      username: schema.igAccounts.username,
    })
    .from(schema.igAccounts)
    .where(
      and(
        eq(schema.igAccounts.orgId, opts.orgId),
        eq(schema.igAccounts.pageId, opts.pageId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    igAccountId: row.id,
    metaIgUserId: row.metaIgUserId,
    username: row.username,
  };
}

export type PublishImageInput = {
  page: PageHandle;
  ig: IgHandle | null;
  imageUrl: string;
  caption: string | null;
  /** When false, only publish to IG (rare). Default true. */
  publishToFb?: boolean;
  /** When true and `ig` is provided, also publish to IG. Default true. */
  publishToIgIfPresent?: boolean;
  /** Optional first comment to drop on the FB post after publishing. */
  firstComment?: string | null;
  calledBy?: string;
};

export type PublishImageResult = {
  fb: { ok: boolean; postId?: string; permalink?: string; error?: string } | null;
  ig: { ok: boolean; mediaId?: string; error?: string } | null;
};

export type PublishVideoInput = {
  page: PageHandle;
  ig: IgHandle | null;
  videoUrl: string;
  caption: string | null;
  /** Title shown on FB videos. Optional. */
  title?: string | null;
  publishToFb?: boolean;
  publishToIgIfPresent?: boolean;
  /** When true (default), IG videos publish as Reels (Meta's preferred path). */
  igAsReel?: boolean;
  calledBy?: string;
};

export type PublishVideoResult = PublishImageResult;

export async function publishImage(
  input: PublishImageInput,
): Promise<PublishImageResult> {
  const out: PublishImageResult = { fb: null, ig: null };
  const publishFb = input.publishToFb ?? true;
  const publishIg = (input.publishToIgIfPresent ?? true) && input.ig !== null;

  // ── Facebook Page
  if (publishFb) {
    const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
    try {
      const res = await meta.request<{ id: string; post_id?: string }>(
        `/${input.page.metaPageId}/photos`,
        {
          method: "POST",
          body: {
            url: input.imageUrl,
            ...(input.caption ? { message: input.caption } : {}),
            published: true,
          },
          calledBy: input.calledBy,
        },
      );
      const postId = res.post_id ?? res.id;
      out.fb = {
        ok: true,
        postId,
        permalink: postId ? `https://www.facebook.com/${postId}` : undefined,
      };

      if (input.firstComment && postId) {
        try {
          await meta.request(`/${postId}/comments`, {
            method: "POST",
            body: { message: input.firstComment },
            calledBy: input.calledBy,
          });
        } catch {
          // First-comment failure is non-fatal.
        }
      }
    } catch (err) {
      out.fb = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Instagram (2-step: create container, then publish)
  if (publishIg && input.ig) {
    const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
    try {
      const container = await meta.request<{ id: string }>(
        `/${input.ig.metaIgUserId}/media`,
        {
          method: "POST",
          body: {
            image_url: input.imageUrl,
            ...(input.caption ? { caption: input.caption } : {}),
          },
          calledBy: input.calledBy,
        },
      );
      const published = await meta.request<{ id: string }>(
        `/${input.ig.metaIgUserId}/media_publish`,
        {
          method: "POST",
          body: { creation_id: container.id },
          calledBy: input.calledBy,
        },
      );
      out.ig = { ok: true, mediaId: published.id };
    } catch (err) {
      out.ig = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return out;
}

/**
 * Image cross-post's video sibling. URL-based: Meta pulls the video from a
 * publicly-reachable URL. For very large files use chunked upload (deferred).
 *
 * - FB Page video: synchronous POST to /{page}/videos with file_url + description.
 * - IG video: 2-step (container → publish), but the container needs a moment
 *   to "process" — we poll status_code up to ~60s before publishing.
 */
export async function publishVideo(
  input: PublishVideoInput,
): Promise<PublishVideoResult> {
  const out: PublishVideoResult = { fb: null, ig: null };
  const publishFb = input.publishToFb ?? true;
  const publishIg = (input.publishToIgIfPresent ?? true) && input.ig !== null;
  const asReel = input.igAsReel ?? true;

  if (publishFb) {
    const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
    try {
      const res = await meta.request<{ id: string }>(
        `/${input.page.metaPageId}/videos`,
        {
          method: "POST",
          body: {
            file_url: input.videoUrl,
            ...(input.caption ? { description: input.caption } : {}),
            ...(input.title ? { title: input.title } : {}),
          },
          calledBy: input.calledBy,
        },
      );
      out.fb = {
        ok: true,
        postId: res.id,
        permalink: `https://www.facebook.com/${input.page.metaPageId}/videos/${res.id}`,
      };
    } catch (err) {
      out.fb = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (publishIg && input.ig) {
    const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
    try {
      const container = await meta.request<{ id: string }>(
        `/${input.ig.metaIgUserId}/media`,
        {
          method: "POST",
          body: {
            video_url: input.videoUrl,
            ...(asReel
              ? { media_type: "REELS", share_to_feed: true }
              : { media_type: "VIDEO" }),
            ...(input.caption ? { caption: input.caption } : {}),
          },
          calledBy: input.calledBy,
        },
      );

      // Poll up to 60s for FINISHED.
      let status = "IN_PROGRESS";
      for (let i = 0; i < 12; i++) {
        await sleep(5_000);
        const s = await meta.request<{ status_code?: string }>(
          `/${container.id}`,
          { query: { fields: "status_code" }, calledBy: input.calledBy },
        );
        status = s.status_code ?? status;
        if (status === "FINISHED" || status === "ERROR" || status === "EXPIRED")
          break;
      }
      if (status !== "FINISHED") {
        throw new Error(`IG container did not become FINISHED (got ${status})`);
      }

      const published = await meta.request<{ id: string }>(
        `/${input.ig.metaIgUserId}/media_publish`,
        {
          method: "POST",
          body: { creation_id: container.id },
          calledBy: input.calledBy,
        },
      );
      out.ig = { ok: true, mediaId: published.id };
    } catch (err) {
      out.ig = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Stories (IG only) ─────────────────────────────────────────────────────
// Facebook Page Stories don't have a stable public Graph API, so this is
// IG-only. Image stories are sync; video stories need the same FINISHED
// polling as Reels.

export type PublishStoryInput = {
  page: PageHandle;
  ig: IgHandle;
  /** Pass exactly one. */
  imageUrl?: string;
  videoUrl?: string;
  calledBy?: string;
};

export type PublishStoryResult = {
  ok: boolean;
  mediaId?: string;
  error?: string;
};

export async function publishStory(
  input: PublishStoryInput,
): Promise<PublishStoryResult> {
  if (!input.imageUrl && !input.videoUrl) {
    return { ok: false, error: "imageUrl or videoUrl required" };
  }
  if (input.imageUrl && input.videoUrl) {
    return { ok: false, error: "pass only one of imageUrl / videoUrl" };
  }
  const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
  try {
    const containerBody: Record<string, unknown> = {
      media_type: "STORIES",
      ...(input.imageUrl
        ? { image_url: input.imageUrl }
        : { video_url: input.videoUrl }),
    };
    const container = await meta.request<{ id: string }>(
      `/${input.ig.metaIgUserId}/media`,
      { method: "POST", body: containerBody, calledBy: input.calledBy },
    );

    if (input.videoUrl) {
      let status = "IN_PROGRESS";
      for (let i = 0; i < 12; i++) {
        await sleep(5_000);
        const s = await meta.request<{ status_code?: string }>(
          `/${container.id}`,
          { query: { fields: "status_code" }, calledBy: input.calledBy },
        );
        status = s.status_code ?? status;
        if (status === "FINISHED" || status === "ERROR" || status === "EXPIRED")
          break;
      }
      if (status !== "FINISHED") {
        throw new Error(
          `Story container did not become FINISHED (got ${status})`,
        );
      }
    }

    const published = await meta.request<{ id: string }>(
      `/${input.ig.metaIgUserId}/media_publish`,
      {
        method: "POST",
        body: { creation_id: container.id },
        calledBy: input.calledBy,
      },
    );
    return { ok: true, mediaId: published.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Carousel ──────────────────────────────────────────────────────────────

export type PublishCarouselInput = {
  page: PageHandle;
  ig: IgHandle | null;
  /** Public URLs for each carousel item, in order. 2-10 items. */
  imageUrls: string[];
  caption: string | null;
  publishToFb?: boolean;
  publishToIgIfPresent?: boolean;
  calledBy?: string;
};

/**
 * Cross-post a multi-image carousel. FB and IG do this differently:
 *
 * - FB: upload each image as an *unpublished* photo to /{page}/photos
 *   (published=false), collect their media_fbids, then post to /{page}/feed
 *   with `attached_media: [{ media_fbid }, ...]` and the message.
 *
 * - IG: create one *child* container per image with media_type=IMAGE +
 *   is_carousel_item=true, then create a parent container with
 *   media_type=CAROUSEL + children=[ids], then media_publish the parent.
 *   Children don't need polling (they're synchronous-ish for images).
 */
export async function publishCarousel(
  input: PublishCarouselInput,
): Promise<PublishImageResult> {
  const out: PublishImageResult = { fb: null, ig: null };
  const publishFb = input.publishToFb ?? true;
  const publishIg = (input.publishToIgIfPresent ?? true) && input.ig !== null;
  if (input.imageUrls.length < 2 || input.imageUrls.length > 10) {
    throw new Error("Carousel needs between 2 and 10 images");
  }

  if (publishFb) {
    const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
    try {
      // 1) Upload each image as unpublished, collect media_fbids.
      const childIds: string[] = [];
      for (const url of input.imageUrls) {
        const r = await meta.request<{ id: string }>(
          `/${input.page.metaPageId}/photos`,
          {
            method: "POST",
            body: { url, published: false },
            calledBy: input.calledBy,
          },
        );
        childIds.push(r.id);
      }
      // 2) Post a feed entry referencing them.
      const feed = await meta.request<{ id: string }>(
        `/${input.page.metaPageId}/feed`,
        {
          method: "POST",
          body: {
            ...(input.caption ? { message: input.caption } : {}),
            attached_media: childIds.map((id) => ({ media_fbid: id })),
          },
          calledBy: input.calledBy,
        },
      );
      out.fb = {
        ok: true,
        postId: feed.id,
        permalink: `https://www.facebook.com/${feed.id}`,
      };
    } catch (err) {
      out.fb = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (publishIg && input.ig) {
    const meta = new MetaClient({ accessToken: input.page.pageAccessToken });
    try {
      // 1) One child container per image.
      const childIds: string[] = [];
      for (const url of input.imageUrls) {
        const r = await meta.request<{ id: string }>(
          `/${input.ig.metaIgUserId}/media`,
          {
            method: "POST",
            body: {
              image_url: url,
              media_type: "IMAGE",
              is_carousel_item: true,
            },
            calledBy: input.calledBy,
          },
        );
        childIds.push(r.id);
      }
      // 2) Parent CAROUSEL container.
      const parent = await meta.request<{ id: string }>(
        `/${input.ig.metaIgUserId}/media`,
        {
          method: "POST",
          body: {
            media_type: "CAROUSEL",
            children: childIds.join(","),
            ...(input.caption ? { caption: input.caption } : {}),
          },
          calledBy: input.calledBy,
        },
      );
      // 3) Publish parent.
      const published = await meta.request<{ id: string }>(
        `/${input.ig.metaIgUserId}/media_publish`,
        {
          method: "POST",
          body: { creation_id: parent.id },
          calledBy: input.calledBy,
        },
      );
      out.ig = { ok: true, mediaId: published.id };
    } catch (err) {
      out.ig = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return out;
}
