/** Geometry of the casing artwork, in its own pixel space.
 *
 *  assets/newcasing.svg is 1430 x 804 and already has the screen, the power button, the
 *  noise knob and the noise switch painted into it. Everything here overlays that
 *  artwork, so these numbers have to match it exactly. designWidth/designHeight in
 *  source/PluginEditor.cpp mirror the first two.
 *
 *  All of it was measured from the artwork rather than estimated -- see the note beside
 *  each control in styles.css for how.
 */
export const design = { width: 1430, height: 804 } as const;

/** The black screen cut-out. The corner radius is larger than half the height, so the
 *  browser clamps it into the squircle the artwork shows. */
export const screen = { x: 64, y: 52, width: 575, height: 527, radius: 230 } as const;

/** Knob travel, matching the printed tick arc: 0% at lower left, 100% at lower right.
 *  The artwork is drawn pointing straight up, which is the middle of that sweep. */
export const knobSweepDegrees = 300;
