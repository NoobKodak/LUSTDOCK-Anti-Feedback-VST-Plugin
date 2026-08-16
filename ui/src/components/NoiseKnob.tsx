import { useCallback, useEffect, useRef } from "react";

import { knobSweepDegrees } from "../layout";
import { useSound } from "../useSound";

interface NoiseKnobProps {
  value: number;
  /** Dead while the noise switch is off: there is nothing downstream to turn up. */
  disabled: boolean;
  onChange: (value: number) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}

/** Pixels of vertical drag for the full 0-100 sweep. */
const dragRange = 220;

/** The rotating face of the Noise knob.
 *
 *  Only the face rotates: the tick ring, the 0 and 100 legends and the "Noise" label
 *  are painted into the casing underneath. btnnoise.svg is drawn pointing straight up,
 *  which is the centre of the printed arc, so 50% needs no rotation.
 */
export function NoiseKnob({ value, disabled, onChange, onGestureStart, onGestureEnd }: NoiseKnobProps) {
  const dragging = useRef<{ startY: number; startValue: number; fine: boolean } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Read inside the window listeners, which are registered once and would otherwise
  // capture a stale value.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const angle = (value - 0.5) * knobSweepDegrees;

  const tick = useSound("sound effect/knob sound effect.mp3");
  const lastPercent = useRef(Math.round(value * 100));

  /** Every change goes through here so the knob ticks once per whole percent, and only
   *  from real interaction -- host automation sweeping the parameter should not make
   *  the interface rattle. Retriggering the same element cuts the previous tick short,
   *  which is what a detent actually sounds like. */
  const emit = useCallback(
    (next: number) => {
      const percent = Math.round(next * 100);

      if (percent !== lastPercent.current) {
        lastPercent.current = percent;
        tick();
      }

      onChange(next);
    },
    [onChange, tick]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;

      event.preventDefault();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      dragging.current = { startY: event.clientY, startValue: valueRef.current, fine: event.shiftKey };
      onGestureStart();
    },
    [disabled, onGestureStart]
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragging.current;
      if (!drag || disabledRef.current) return;

      // The stage is CSS-scaled, so screen pixels and design pixels differ. Using the
      // raw pointer delta keeps the feel identical at any editor size.
      const sensitivity = (drag.fine || event.shiftKey ? 4 : 1) * dragRange;
      const next = drag.startValue - (event.clientY - drag.startY) / sensitivity;
      emit(Math.min(1, Math.max(0, next)));
    };

    const up = () => {
      if (!dragging.current) return;
      dragging.current = null;
      onGestureEnd();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [emit, onGestureEnd]);

  const wheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (disabled) return;

      const step = event.deltaY < 0 ? 0.01 : -0.01;
      onGestureStart();
      emit(Math.min(1, Math.max(0, valueRef.current + step)));
      onGestureEnd();
    },
    [disabled, emit, onGestureStart, onGestureEnd]
  );

  return (
    <div
      className={`noise-knob ${disabled ? "is-disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="Noise reduction"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={`${Math.round(value * 100)} percent`}
      title={disabled ? "Noise reduction is switched off" : `Noise ${Math.round(value * 100)}%`}
      onPointerDown={handlePointerDown}
      onWheel={wheel}
      onDoubleClick={() => {
        if (disabled) return;
        onGestureStart();
        emit(0);
        onGestureEnd();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = event.shiftKey ? 0.01 : 0.05;
        const delta =
          event.key === "ArrowUp" || event.key === "ArrowRight" ? step
          : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -step
          : 0;

        if (delta === 0) return;
        event.preventDefault();
        onGestureStart();
        emit(Math.min(1, Math.max(0, valueRef.current + delta)));
        onGestureEnd();
      }}
    >
      <img
        src="btnnoise.svg"
        alt=""
        draggable={false}
        style={{ transform: `rotate(${angle}deg)` }}
      />
    </div>
  );
}
