/*  Brand assets: rasterise and re-encode.

    Every large "SVG" in public/brand is a PNG in a costume -- an <image> whose href is a
    base64 data URI. That is the worst of both formats: none of SVG's scaling, plus
    base64's 33% inflation on an already-unoptimised PNG. public/brand came to 30.7 MB,
    and five of these load on the front page at once.

    The obvious move is to pull the embedded PNG straight out. That was tried and it
    broke the hero: the wrapper is not just packaging, it *positions and scales* the
    bitmap inside a declared canvas. The five hero layers each carry a 1536x1024 or
    480x480 bitmap placed inside a 2162x1742 frame, so extracting the raw pixels gave
    five images with aspect ratios of 1.777, 1.5 and 1.0 where the composition needs one
    shared 1.241 -- the layers no longer registered on top of one another.

    So the SVG is *rendered* at its own canvas size instead. Whatever the wrapper was
    doing to place the bitmap is preserved, because the renderer does it.

    Usage:  node scripts/brand-to-webp.mjs
*/

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/*  fileURLToPath, not url.pathname. This project lives under "VST CREATION" -- a path
    with a space in it -- and .pathname hands back the percent-encoded form, so the
    directory read looks for "VST%20CREATION" and fails.                             */
const ROOT = fileURLToPath(new URL("../public/brand", import.meta.url));

/** Quality 82 is the usual sweet spot for painted artwork: no visible difference at 1:1
 *  and a fraction of the bytes. Lossless would undo most of the win. */
const QUALITY = 82;

/*  The widest any of these is drawn is about 970 CSS px in the hero. 1800 gives a
    comfortable margin for high-density screens without paying for pixels nobody sees --
    the source canvases are 2162 wide, so this is a mild downscale at most.           */
const MAX_WIDTH = 1800;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const results = [];

for await (const file of walk(ROOT)) {
  if (extname(file).toLowerCase() !== ".svg") continue;

  const svg = await readFile(file);

  // A real vector SVG has no embedded bitmap; those are already tiny, so leave them.
  if (!/data:image\/(png|jpe?g);base64/.test(svg.toString("utf8"))) continue;

  const before = (await stat(file)).size;
  const source = sharp(svg, { density: 144 });
  const meta = await source.metadata();

  const width = Math.min(meta.width ?? MAX_WIDTH, MAX_WIDTH);

  const out = file.replace(/\.svg$/i, ".webp");
  const info = await sharp(svg, { density: 144 })
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(out);

  results.push({
    file: relative(ROOT, file).replace(/\\/g, "/"),
    beforeKb: Math.round(before / 1024),
    afterKb: Math.round(info.size / 1024),
    canvas: `${meta.width}x${meta.height}`,
    out: `${info.width}x${info.height}`,
    ratio: (info.width / info.height).toFixed(3),
  });
}

results.sort((a, b) => b.beforeKb - a.beforeKb);

let before = 0;
let after = 0;

for (const r of results) {
  before += r.beforeKb;
  after += r.afterKb;
  const saved = Math.round((1 - r.afterKb / r.beforeKb) * 100);
  console.log(
    `${String(r.beforeKb).padStart(6)} KB -> ${String(r.afterKb).padStart(5)} KB ` +
    `(-${String(saved).padStart(2)}%)  canvas ${r.canvas.padEnd(10)} out ${r.out.padEnd(10)} ` +
    `ratio ${r.ratio}  ${r.file}`
  );
}

console.log(
  `\n${results.length} converted: ` +
  `${(before / 1024).toFixed(1)} MB -> ${(after / 1024).toFixed(1)} MB ` +
  `(-${Math.round((1 - after / before) * 100)}%)`
);
