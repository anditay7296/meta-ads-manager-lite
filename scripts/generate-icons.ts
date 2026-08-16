/**
 * Generates the app icon set from inline SVG. White glyph on the Telegram blue
 * gradient tile, one glyph per surface:
 *   root       -> "AI" lettermark
 *   /telegram  -> paper plane
 *   /dashboard -> ascending bar chart
 *
 *   node --import tsx scripts/generate-icons.ts
 *
 * Root writes app/icon.svg + app/apple-icon.png + app/favicon.ico + public/icon-*.
 * Per-route writes app/(app)/<route>/{icon.svg,apple-icon.png} (Next emits a
 * route-scoped <link>, overriding root for that page) + public/icon-<route>-192.png
 * (referenced by the manifest `shortcuts`). Edit a glyph below and re-run. Keep in repo.
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

// "AI" lettermark, drawn as paths (not text) so it rasterizes without a font
// dependency. Deliberately NOT Meta's "infinity" mark — that was the icon until
// 2026-07-21; using Meta's brand marks in our own app icon violates their brand
// guidelines and is a rejection reason in App Review. Keep it a lettermark.
//
// Built in 240-space, bbox exactly 52..188 x 72..168 so it is centred on (120,120).
// The A is one evenodd path: outer outline with a notch between the legs, plus a
// triangular counter above the crossbar. Leg edges are parallel at dx/dy = 0.354.
const LETTER_A =
  "M52 168L86 72H114L148 168H124L117.6 150H82.4L76 168ZM88.7 132H111.3L100 100Z";
const LETTER_I = "M164 72H188V168H164Z";

// Telegram paper plane, already in 240-space (bbox center ~114.6, 123.5).
const PLANE =
  "M54.3 118.8c34.97-15.24 58.3-25.3 69.97-30.16 33.32-13.86 40.24-16.26 44.75-16.34.99-.02 3.21.23 4.65 1.4.99.79 1.04 1.86 1.13 2.61.16 1.46.36 4.78.21 7.38-1.13 19.45-6.49 66.62-9.21 88.38-1.16 9.21-3.42 12.29-5.61 12.49-4.76.44-8.38-3.15-12.99-6.17-7.21-4.73-11.29-7.67-18.28-12.28-8.08-5.33-2.84-8.26 1.76-13.04 1.21-1.25 22.16-20.32 22.57-22.05.05-.22.1-1.02-.38-1.45-.48-.43-1.19-.28-1.7-.16-.72.16-12.24 7.78-34.55 22.85-3.27 2.25-6.23 3.34-8.88 3.28-2.93-.06-8.56-1.65-12.74-3.01-5.13-1.67-9.21-2.55-8.85-5.39.18-1.48 2.22-2.99 6.1-4.55z";

// Telegram blue gradient (top -> bottom), userSpaceOnUse over the 240 box.
const GRAD =
  '<linearGradient id="tg" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2AABEE"/><stop offset="1" stop-color="#229ED9"/></linearGradient>';

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs>${GRAD}</defs>${body}</svg>`;
const circleBg = '<circle cx="120" cy="120" r="120" fill="url(#tg)"/>';
const squareBg = '<rect width="240" height="240" fill="url(#tg)"/>';

// White glyphs in 240-space. `full` variants sit inside the maskable safe zone.
const aiMark = (s: number) =>
  `<g transform="translate(120 120) scale(${s}) translate(-120 -120)" fill="#fff">` +
  `<path fill-rule="evenodd" d="${LETTER_A}"/><path d="${LETTER_I}"/></g>`;
const planeCircle = `<path fill="#fff" d="${PLANE}"/>`;
const planeFull = `<g transform="translate(120 120) scale(1.2) translate(-114.6 -123.5)"><path fill="#fff" d="${PLANE}"/></g>`;
const chart =
  '<g fill="#fff"><rect x="56" y="136" width="22" height="40" rx="5"/><rect x="91" y="110" width="22" height="66" rx="5"/><rect x="126" y="84" width="22" height="92" rx="5"/><rect x="161" y="60" width="22" height="116" rx="5"/></g>';
// Four-point AI sparkles (big + small), concave sides via quadratics through the center.
const sparkle =
  '<g fill="#fff"><path d="M120 52Q120 120 188 120Q120 120 120 188Q120 120 52 120Q120 120 120 52Z"/><path d="M167 57Q167 74 184 74Q167 74 167 91Q167 74 150 74Q167 74 167 57Z"/></g>';
// Bullseye (audience targeting): two rings + center dot.
const bullseye =
  '<g fill="none" stroke="#fff"><circle cx="120" cy="120" r="54" stroke-width="16"/><circle cx="120" cy="120" r="26" stroke-width="14"/></g><circle cx="120" cy="120" r="9" fill="#fff"/>';

// [circle tile (transparent corners), full-bleed tile] per surface.
const rootIcon = { circle: svg(circleBg + aiMark(1.15)), full: svg(squareBg + aiMark(1.05)) };
const telegram = { circle: svg(circleBg + planeCircle), full: svg(squareBg + planeFull) };
const dashboard = { circle: svg(circleBg + chart), full: svg(squareBg + chart) };
const agent = { circle: svg(circleBg + sparkle), full: svg(squareBg + sparkle) };
const campaigns = { circle: svg(circleBg + bullseye), full: svg(squareBg + bullseye) };
// Photo/image (creative library): rounded frame with the sun + mountains knocked out (evenodd).
const photo =
  '<path fill="#fff" fill-rule="evenodd" d="M76 80H164A16 16 0 0 1 180 96V144A16 16 0 0 1 164 160H76A16 16 0 0 1 60 144V96A16 16 0 0 1 76 80ZM86 89a11 11 0 1 0 0 22a11 11 0 1 0 0-22ZM70 152L100 116L120 136L144 110L172 152Z"/>';
const creatives = { circle: svg(circleBg + photo), full: svg(squareBg + photo) };

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
  // Root — "AI" lettermark
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
  for (const [route, label, art] of [
    ["telegram", "Telegram", telegram],
    ["dashboard", "Dashboard", dashboard],
    ["agent", "Agent", agent],
    ["campaigns", "Campaigns", campaigns],
    ["creatives", "Creatives", creatives],
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
      theme_color: "#229ED9",
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
