import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/*  The hero artwork, as five aligned plates.

    The five files are the same drawing separated into parts, so they are registered on
    top of one another rather than fanned out -- the composition only reads correctly
    when every plate sits exactly where it was drawn. Depth comes from how far each one
    drifts under the cursor, not from a static offset.

    Alignment is by height, not by box. Four of the files are 2162 x 1742 and one is
    2193 x 1742: the drawings share a height and differ in canvas width. Stretching each
    to a common box would distort the odd one out, so every plate is given the frame's
    full height, its own natural width, and is centred. Same height plus same centre
    means registered, without a pixel of distortion.

    `order` is the stacking, back to front. Layer 3 is deliberately last, so it sits on
    top of the rest and takes the largest drift.                                       */

const LAYERS = [
  { src: "/brand/layers/1.webp" },
  { src: "/brand/layers/2.webp" },
  { src: "/brand/layers/4.webp" },
  { src: "/brand/layers/5.webp" },
  { src: "/brand/layers/3.webp" },   // front
];

const LAST = LAYERS.length - 1;

/** How far the front plate drifts with the cursor, in pixels. */
const DRIFT = 22;

export function DeviceShowcase({ className }: { className?: string }) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = frame.current;
    if (!host) return;

    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let queued = 0;
    let targetX = 0;
    let targetY = 0;

    const apply = () => {
      queued = 0;
      host.style.setProperty("--px", targetX.toFixed(4));
      host.style.setProperty("--py", targetY.toFixed(4));
    };

    const schedule = () => { if (!queued) queued = requestAnimationFrame(apply); };

    /*  Bound to the artwork itself rather than the window.

        Listening globally meant the plates answered a cursor halfway across the page,
        which reads as the picture twitching at nothing. On the element, the effect only
        exists where the pointer actually is.                                          */
    const onMove = (event: PointerEvent) => {
      const box = host.getBoundingClientRect();

      // -1..1 from the centre, so the drift is symmetrical and settles back to a clean
      // stack when the pointer sits in the middle of the artwork.
      targetX = ((event.clientX - box.left) / box.width - 0.5) * 2;
      targetY = ((event.clientY - box.top) / box.height - 0.5) * 2;
      schedule();
    };

    const onLeave = () => { targetX = 0; targetY = 0; schedule(); };

    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", onLeave);

    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      if (queued) cancelAnimationFrame(queued);
    };
  }, []);

  return (
    <div className={cn("w-full", className)}>
      <p className="mb-3 flex items-center gap-2 t-label text-muted-foreground">
        <span className="inline-block h-px w-6 bg-current" aria-hidden="true" />
        Layers
      </p>

      {/*  The frame reserves the artwork's aspect ratio, so the space is held before any
          of the five files decode and nothing below moves as they arrive.             */}
      {/*  A one-cell grid, not absolute positioning.

          Every plate is placed in the same cell and centred there. Auto margins were the
          obvious way to centre them and quietly fail: one file's canvas is 31px wider
          than the rest, so it is wider than the frame, and `margin: auto` on an element
          larger than its container is over-constrained -- the browser keeps the left
          margin and drops the right, shunting that one plate several pixels off centre
          from the other four. A centred grid item overflows evenly on both sides.     */}
      {/*  The plates are taken out of flow, and that is load-bearing.

          They are sized `h-full w-auto max-w-none` so every layer renders at the same
          height whatever its canvas width -- but an in-flow element with no max-width
          contributes its *intrinsic* width to the layout, and one of these files is
          2193px wide. In a grid that made the whole hero column 2193px wide, which was
          invisible on a desktop with room to spare and burst the page open on a phone.

          Absolute positioning removes them from intrinsic sizing entirely, so the frame
          is measured by its aspect ratio alone. Centring is then left:50% plus a -50%
          shift folded into the same `translate` the parallax writes to, because two
          rules both setting `translate` would overwrite one another.                 */}
      <div ref={frame} className="relative w-full [aspect-ratio:2162/1742]">
        {LAYERS.map((layer, i) => (
          <img
            key={layer.src}
            src={layer.src}
            alt=""
            aria-hidden="true"
            draggable={false}
            /*  All five eagerly. They are one picture cut into five files, all of it
                above the fold; lazily, four fifths of the artwork waits for an
                intersection that has already happened and assembles in front of the
                reader.                                                               */
            loading="eager"
            decoding="async"
            className="hero-plate absolute top-0 left-1/2 h-full w-auto max-w-none"
            style={{
              ["--layer-drift" as string]: `${(i / LAST) * DRIFT}px`,
              ["--layer-delay" as string]: `${i * 0.45}s`,
              zIndex: i,
            }}
          />
        ))}
      </div>

      <p className="sr-only">
        The LOST DUCK Anti Feedback plug-in, drawn as five stacked layers.
      </p>
    </div>
  );
}
