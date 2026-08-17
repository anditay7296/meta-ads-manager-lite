/**
 * Generates the app icon set from inline SVG. Everything sits on the brand's
 * dark tile; the glyph changes per surface:
 *   root       -> the AI Mastermind mark (gradient, from lib/brand.ts)
 *   /dashboard -> ascending bar chart (white)
 *   /campaigns -> bullseye (white)
 *
 *   node --import tsx scripts/generate-icons.ts
 *
 * Root writes app/icon.svg + app/apple-icon.png + app/favicon.ico + public/icon-*
 * + public/logo.svg / public/logo.png. Per-route writes
 * app/(app)/<route>/{icon.svg,apple-icon.png} (Next emits a route-scoped <link>,
 * overriding root for that page) + public/icon-<route>-192.png (referenced by the
 * manifest `shortcuts`). Edit a glyph below and re-run. Keep in repo.
 *
 * The root mark's geometry is NOT defined here — it lives in lib/brand.ts so
 * that components/app-shell/Logo.tsx renders the identical shape in the sidebar.
 * Change it there and re-run this script; changing it here alone makes the tab
 * icon and the in-app logo drift apart.
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BRAND_ACCENT,
  MARK_FACETS,
  MARK_GRADIENTS,
  MARK_VIEWBOX,
  TILE_BG_FROM,
  TILE_BG_TO,
} from "../lib/brand";

const root = process.cwd();

// The mark's four facet gradients, plus the dark tile every surface sits on.
const GRAD =
  MARK_GRADIENTS.map(
    (g) =>
      `<linearGradient id="${g.id}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${g.from}"/><stop offset="1" stop-color="${g.to}"/></linearGradient>`,
  ).join("") +
  `<linearGradient id="tile" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${TILE_BG_FROM}"/><stop offset="1" stop-color="${TILE_BG_TO}"/></linearGradient>`;

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs>${GRAD}</defs>${body}</svg>`;
const circleBg = '<circle cx="120" cy="120" r="120" fill="url(#tile)"/>';
const squareBg = '<rect width="240" height="240" fill="url(#tile)"/>';

// Glyphs in 240-space. `full` variants sit inside the maskable safe zone (a
// centred circle at 80% of the tile), so they are scaled down relative to
// `circle`, whose corners are already clipped away.
const facets = MARK_FACETS.map(
  (f) => `<path d="${f.d}" fill="url(#${f.fill})"/>`,
).join("");
const mMark = (s: number) =>
  `<g transform="translate(120 120) scale(${s}) translate(-120 -120)">${facets}</g>`;
const chart =
  '<g fill="#fff"><rect x="56" y="136" width="22" height="40" rx="5"/><rect x="91" y="110" width="22" height="66" rx="5"/><rect x="126" y="84" width="22" height="92" rx="5"/><rect x="161" y="60" width="22" height="116" rx="5"/></g>';
// Bullseye (audience targeting): two rings + center dot.
const bullseye =
  '<g fill="none" stroke="#fff"><circle cx="120" cy="120" r="54" stroke-width="16"/><circle cx="120" cy="120" r="26" stroke-width="14"/></g><circle cx="120" cy="120" r="9" fill="#fff"/>';

// [circle tile (transparent corners), full-bleed tile] per surface.
const rootIcon = { circle: svg(circleBg + mMark(0.95)), full: svg(squareBg + mMark(0.85)) };
const dashboard = { circle: svg(circleBg + chart), full: svg(squareBg + chart) };
const campaigns = { circle: svg(circleBg + bullseye), full: svg(squareBg + bullseye) };

// The bare mark on transparency, tightly cropped — served at /logo.svg and
// /logo.png for anywhere the lockup is composed outside React. In-app the
// sidebar inlines it via components/app-shell/Logo.tsx instead.
const bareMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}"><defs>${GRAD}</defs>${facets}</svg>`;

// High density so the 240-unit viewBox rasterizes well above any target, then downscales crisp.
const png = (s: string, size: number) =>
  sharp(Buffer.from(s), { density: 512 }).resize(size, size).png().toBuffer();

/** Assemble a multi-image .ico from PNG buffers (PNG-in-ICO; valid on all modern browsers). */
function buildIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width  (0 = 256)
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
    e.writeUInt8(0, 2); // palette count
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function main() {
  // The in-app logo: vector plus a 4x raster fallback. Width-only resize keeps
  // the mark's 176x96 aspect instead of padding it into a square.
  await writeFile(join(root, "public/logo.svg"), bareMark);
  await writeFile(
    join(root, "public/logo.png"),
    await sharp(Buffer.from(bareMark), { density: 512 })
      .resize({ width: 704 })
      .png()
      .toBuffer(),
  );

  // Root — the AI Mastermind mark
  await writeFile(join(root, "app/icon.svg"), rootIcon.circle);
  await writeFile(join(root, "app/apple-icon.png"), await png(rootIcon.full, 180));
  await writeFile(join(root, "public/icon-192.png"), await png(rootIcon.circle, 192));
  await writeFile(join(root, "public/icon-512.png"), await png(rootIcon.circle, 512));
  await writeFile(join(root, "public/icon-192-maskable.png"), await png(rootIcon.full, 192));
  await writeFile(join(root, "public/icon-512-maskable.png"), await png(rootIcon.full, 512));
  await writeFile(
    join(root, "app/favicon.ico"),
    buildIco([
      { size: 16, data: await png(rootIcon.circle, 16) },
      { size: 32, data: await png(rootIcon.circle, 32) },
      { size: 48, data: await png(rootIcon.circle, 48) },
    ]),
  );

  // Per-route surfaces. Each route also gets its own .webmanifest whose
  // start_url is the route itself — installed shortcuts launch at the manifest
  // start_url (NOT the page they were added from), so sharing the root manifest
  // sent every tile to "/" -> /dashboard. Distinct manifests also make Android
  // treat each as its own installable app, so per-route icons work there too.
  // Lite ships two per-route icon sets. The parent's telegram / agent /
  // creatives routes do not exist here, and writing into their deleted
  // directories throws ENOENT.
  for (const [route, label, art] of [
    ["dashboard", "Dashboard", dashboard],
    ["campaigns", "Campaigns", campaigns],
  ] as const) {
    await writeFile(join(root, `app/(app)/${route}/icon.svg`), art.circle);
    await writeFile(join(root, `app/(app)/${route}/apple-icon.png`), await png(art.full, 180));
    await writeFile(join(root, `public/icon-${route}-192.png`), await png(art.circle, 192));
    await writeFile(join(root, `public/icon-${route}-512.png`), await png(art.circle, 512));
    await writeFile(join(root, `public/icon-${route}-512-maskable.png`), await png(art.full, 512));
    const manifest = {
      name: label,
      short_name: label,
      start_url: `/${route}`,
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: BRAND_ACCENT,
      icons: [
        { src: `/icon-${route}-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `/icon-${route}-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: `/icon-${route}-512-maskable.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    };
    await writeFile(
      join(root, `public/manifest-${route}.webmanifest`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }

  console.log("✓ icon set + per-route manifests generated");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
