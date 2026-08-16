import { createClient } from "@supabase/supabase-js";

const BUCKET = "post-assets";

/** Public bucket holding our rehosted copies of Meta creative stills, so the
 *  /creatives grid never depends on Meta's ~30d-expiring signed CDN URLs. */
const CREATIVE_BUCKET = "creative-thumbs";

/**
 * Construct the public URL for a stored post asset given its bucket-relative
 * path. Mirrors what `supabase.storage.from(BUCKET).getPublicUrl()` returns,
 * but synchronous and dependency-free so it can be called on the server in
 * tight render loops (e.g. the grouped /content list) without paying a
 * client-instantiation cost per row.
 */
export function postAssetPublicUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

let cached: ReturnType<typeof createClient> | null = null;

function admin() {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    throw new Error(
      "Supabase URL + service role key required for server-side storage uploads",
    );
  }
  cached = createClient(url, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

/**
 * Ensure the post-assets bucket exists. Idempotent. Public read so Meta can
 * fetch the image URL during posting.
 */
export async function ensurePostAssetsBucket(): Promise<void> {
  const sb = admin();
  // listBuckets is fast — cheaper than catching the create-failure path.
  const { data, error } = await sb.storage.listBuckets();
  if (error) throw error;
  if (data?.some((b) => b.name === BUCKET)) return;
  const { error: createErr } = await sb.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 50_485_760, // ~50 MB to fit short videos
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/quicktime",
    ],
  });
  if (createErr && createErr.message !== "Bucket already exists")
    throw createErr;
}

export type UploadedAsset = {
  path: string;
  publicUrl: string;
  size: number;
  mimeType: string;
};

/**
 * Upload a File from a Server Action into post-assets, return the public URL.
 * Path is `<orgId>/<userId>/<timestamp>-<random>-<filename>` so each org's
 * uploads are namespaced even though the bucket is single-tenant.
 */
export async function uploadPostAsset(opts: {
  orgId: string;
  userId: string;
  file: File;
}): Promise<UploadedAsset> {
  const sb = admin();
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safeName = opts.file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const path = `${opts.orgId}/${opts.userId}/${ts}-${rand}-${safeName}`;
  const arrayBuffer = await opts.file.arrayBuffer();
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(path, arrayBuffer, {
      contentType: opts.file.type || "application/octet-stream",
      upsert: false,
    });
  if (error) throw error;
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  return {
    path,
    publicUrl: pub.publicUrl,
    size: opts.file.size,
    mimeType: opts.file.type,
  };
}

const POST_ASSET_MAX_BYTES = 50_485_760; // mirror the bucket's fileSizeLimit
const POST_ASSET_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

export type SignedAssetUpload = {
  fileName: string;
  path: string;
  token: string;
  publicUrl: string;
};

/**
 * Mint signed upload URLs so the BROWSER can PUT large files straight into
 * post-assets (the factory's 30-image + 20-video batches would blow the ~1MB
 * server-action body limit if they traveled through a form POST). The signed
 * token itself authorizes the write, so the client only needs the anon key —
 * no RLS or bucket-policy changes — and the bucket stays public-read so Meta
 * can fetch the media. Same path scheme as uploadPostAsset.
 */
export async function createSignedAssetUploads(opts: {
  orgId: string;
  userId: string;
  files: Array<{ name: string; type: string; size: number }>;
}): Promise<SignedAssetUpload[]> {
  const sb = admin();
  const out: SignedAssetUpload[] = [];
  for (const f of opts.files) {
    if (!POST_ASSET_MIME_TYPES.has(f.type)) {
      throw new Error(`Unsupported file type ${f.type || "unknown"} for "${f.name}"`);
    }
    if (f.size > POST_ASSET_MAX_BYTES) {
      throw new Error(`"${f.name}" is over the 50MB limit`);
    }
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const path = `${opts.orgId}/${opts.userId}/${ts}-${rand}-${safeName}`;
    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(
        `Could not create signed upload for "${f.name}": ${error?.message ?? "no data"}`,
      );
    }
    out.push({
      fileName: f.name,
      path: data.path,
      token: data.token,
      publicUrl: postAssetPublicUrl(data.path),
    });
  }
  return out;
}

/**
 * Ensure the public `creative-thumbs` bucket exists. Idempotent. Image-only,
 * small file-size cap — these are still-frames, not the source videos.
 */
export async function ensureCreativeThumbsBucket(): Promise<void> {
  const sb = admin();
  const { data, error } = await sb.storage.listBuckets();
  if (error) throw error;
  if (data?.some((b) => b.name === CREATIVE_BUCKET)) return;
  const { error: createErr } = await sb.storage.createBucket(CREATIVE_BUCKET, {
    public: true,
    fileSizeLimit: 10_485_760, // 10 MB — generous for a 600px still
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  });
  if (createErr && createErr.message !== "Bucket already exists")
    throw createErr;
}

/**
 * Download a Meta creative still from `sourceUrl` and rehost it in the public
 * `creative-thumbs` bucket at `<orgId>/<metaCreativeId>.<ext>`, returning the
 * stable public URL. Best-effort: returns `null` (never throws) on any fetch /
 * non-image / upload failure so the caller can leave `cached_thumb_url` null
 * and fall back to the Meta URL. `upsert: true` keeps re-runs idempotent.
 */
export async function cacheCreativeThumb(opts: {
  orgId: string;
  metaCreativeId: string;
  sourceUrl: string;
}): Promise<string | null> {
  try {
    const res = await fetch(opts.sourceUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
          ? "gif"
          : "jpg";
    const safeId = opts.metaCreativeId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${opts.orgId}/${safeId}.${ext}`;
    const sb = admin();
    const { error } = await sb.storage
      .from(CREATIVE_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });
    if (error) return null;
    const { data: pub } = sb.storage.from(CREATIVE_BUCKET).getPublicUrl(path);
    return pub.publicUrl;
  } catch {
    return null;
  }
}

/**
 * Batch-delete bucket-relative paths from `creative-thumbs`. Used by the
 * daily prune job to reclaim storage for creatives whose ads are all
 * ARCHIVED/DELETED, or that have no ads at all. Chunks into ≤100-path
 * batches per Supabase's guidance; a failed batch is collected rather than
 * thrown so the caller can still clear the DB column for paths that did
 * delete and retry the rest on the next run.
 */
export async function deleteCreativeThumbPaths(
  paths: string[],
): Promise<{ deleted: string[]; failed: string[] }> {
  const sb = admin();
  const deleted: string[] = [];
  const failed: string[] = [];
  const BATCH = 100;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const { error } = await sb.storage.from(CREATIVE_BUCKET).remove(batch);
    if (error) failed.push(...batch);
    else deleted.push(...batch);
  }
  return { deleted, failed };
}
