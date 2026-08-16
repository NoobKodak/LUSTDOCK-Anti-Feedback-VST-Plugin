import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";

import type { Frame } from "../bridge";
import { screen } from "../layout";

interface ScopeProps {
  /** Written 30x a second by the JUCE event listener. Read here rather than passed as
   *  a prop so the waveform never costs a React render. */
  frameRef: MutableRefObject<Frame>;
  on: boolean;
}

/** Below this peak the input counts as silence and the display drifts to its idle sine
 *  instead of drawing a flat line. */
const silenceFloor = 0.02;

const colours = {
  quiet: { line: "#3df2a0", glow: "rgba(61, 242, 160, 0.55)" },
  working: { line: "#ffa32e", glow: "rgba(255, 163, 46, 0.6)" },
  off: { line: "#48545f", glow: "rgba(72, 84, 95, 0.25)" },
};

export function Scope({ frameRef, on }: ScopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onRef = useRef(on);
  onRef.current = on;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let animation = 0;
    const started = performance.now();

    const draw = () => {
      animation = requestAnimationFrame(draw);

      const { width, height } = canvas;
      const middle = height / 2;
      const elapsed = (performance.now() - started) / 1000;

      const { points, peak, detector } = frameRef.current;
      const powered = onRef.current;
      const suppressing = detector.notches.length > 0;

      context.clearRect(0, 0, width, height);

      // Tube glass: brighter in the middle, falling away to black at the bezel.
      const backdrop = context.createRadialGradient(
        width / 2, middle, 0,
        width / 2, middle, Math.max(width, height) * 0.62
      );
      backdrop.addColorStop(0, "#0d1620");
      backdrop.addColorStop(0.55, "#060a0f");
      backdrop.addColorStop(1, "#000000");
      context.fillStyle = backdrop;
      context.fillRect(0, 0, width, height);

      drawGrid(context, width, height, middle);

      const palette = !powered ? colours.off : suppressing ? colours.working : colours.quiet;

      // How much of the real signal to show. Silence crossfades into the idle sine so
      // the screen never sits as a dead flat line.
      const liveness = powered ? Math.min(1, peak / silenceFloor) : 0;
      const count = points.length > 1 ? points.length : 180;

      const sampleAt = (index: number) => {
        const phase = (index / (count - 1)) * Math.PI * 6 - elapsed * 2.2;
        const idle = Math.sin(phase) * 0.24;
        const live = points.length > 1 ? points[index] ?? 0 : 0;

        return live * liveness + idle * (1 - liveness) * (powered ? 1 : 0.45);
      };

      const amplitude = middle * 0.78;
      const step = width / (count - 1);

      const trace: Array<[number, number]> = [];
      for (let i = 0; i < count; i += 1) {
        trace.push([i * step, middle - Math.max(-1, Math.min(1, sampleAt(i))) * amplitude]);
      }

      // Soft body under the curve, then the curve itself on top of it.
      context.beginPath();
      context.moveTo(0, middle);
      for (const [x, y] of trace) context.lineTo(x, y);
      context.lineTo(width, middle);
      context.closePath();

      const body = context.createLinearGradient(0, 0, 0, height);
      body.addColorStop(0, palette.glow);
      body.addColorStop(0.5, "rgba(0, 0, 0, 0)");
      body.addColorStop(1, palette.glow);
      context.globalAlpha = 0.22;
      context.fillStyle = body;
      context.fill();
      context.globalAlpha = 1;

      context.beginPath();
      for (let i = 0; i < trace.length; i += 1) {
        const [x, y] = trace[i];
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }

      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = palette.line;
      context.lineWidth = powered ? 5 : 3.5;
      context.shadowColor = palette.glow;
      context.shadowBlur = powered ? 26 : 8;
      context.stroke();

      // A second pass with no shadow keeps the core of the line crisp inside the bloom.
      context.shadowBlur = 0;
      context.lineWidth = powered ? 2.4 : 1.8;
      context.strokeStyle = powered ? "#e9fff5" : "#7c8894";
      context.stroke();
    };

    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [frameRef]);

  return (
    <canvas
      ref={canvasRef}
      className="scope"
      width={screen.width * 2}
      height={screen.height * 2}
    />
  );
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  middle: number
) {
  context.save();
  context.strokeStyle = "rgba(120, 190, 255, 0.09)";
  context.lineWidth = 2;

  for (let i = 1; i < 8; i += 1) {
    const x = (width * i) / 8;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  for (let i = 1; i < 6; i += 1) {
    const y = (height * i) / 6;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  context.strokeStyle = "rgba(120, 190, 255, 0.22)";
  context.beginPath();
  context.moveTo(0, middle);
  context.lineTo(width, middle);
  context.stroke();
  context.restore();
}
