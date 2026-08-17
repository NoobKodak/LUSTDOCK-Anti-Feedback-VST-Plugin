/*  Builds the site's icon set from the running figure.

    Run:  node scripts/make-favicons.mjs

    Source is public/brand/runlogo.webp rather than assets/new-assets/runlogo.svg, which
    only looks like vector art -- it is a 2.7 MB wrapper around an embedded raster, so it
    would rescale no better than the webp and cost forty times the bytes.

    Two things this has to get right that a plain resize does not:

    The mark is a tall figure on a mostly empty canvas. Dropped into a square untouched it
    becomes a small red smudge with air on both sides, so the artwork is trimmed to its own
    ink first and only then centred -- that is what makes it legible at 16 px.

    Apple ignores transparency and composites its touch icon onto black, which would turn a
    red figure into a dark smear on a dark ground. That one output gets the site's own white
    background baked in; everything else stays transparent so it works on any tab bar.     */

import sharp from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const source = "public/brand/runlogo.webp";
const out = "public";

/** Fraction of the square left as breathing room. Below about 8% the figure touches the
 *  edges and reads as a crop; above about 14% it starts to look lost in its own box. */
const margin = 0.1;

/** Renders the trimmed mark centred in a transparent square. */
async function square(size) {
  const inner = Math.round(size * (1 - margin * 2));

  const mark = await sharp(source)
    .trim()                                    // strip the empty canvas around the figure
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/*  Assembles a .ico by hand.

    There is no dependency for this and it does not need one: an icon file is a six byte
    header, a sixteen byte directory entry per image, and then the images. Since Vista the
    images may be PNG rather than the old DIB format, which is what makes this short.     */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const directory = Buffer.alloc(16 * pngs.length);
  let offset = header.length + directory.length;

  pngs.forEach(({ size, data }, i) => {
    const at = i * 16;
    // 0 means 256 in this field, which is why it is a single byte and still enough.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);     // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3);     // reserved
    directory.writeUInt16LE(1, at + 4);  // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...pngs.map((p) => p.data)]);
}

await mkdir(join(out, "brand"), { recursive: true });

// 16 and 32 are the tab and bookmark sizes; 48 is what Windows uses for a pinned site.
const icoSizes = [16, 32, 48];
const icoParts = [];

for (const size of icoSizes) {
  icoParts.push({ size, data: await square(size) });
}

await writeFile(join(out, "favicon.ico"), ico(icoParts));

// Standalone PNGs. Browsers prefer these when offered; the .ico is the old fallback.
for (const size of [32, 192, 512]) {
  await writeFile(join(out, `icon-${size}.png`), await square(size));
}

// The one that must not be transparent. White, matching the site's own background.
const touch = 180;
const touchInner = Math.round(touch * (1 - margin * 2));

await writeFile(
  join(out, "apple-touch-icon.png"),
  await sharp({
    create: {
      width: touch,
      height: touch,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp(source)
          .trim()
          .resize(touchInner, touchInner, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer(),
        gravity: "center",
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer()
);

const trimmed = await sharp(source).trim().metadata();
console.log(`source   ${source}`);
console.log(`trimmed  ${trimmed.width}x${trimmed.height} (was 718x890)`);
console.log(`wrote    favicon.ico (${icoSizes.join(", ")}), icon-32/192/512.png, apple-touch-icon.png`);
