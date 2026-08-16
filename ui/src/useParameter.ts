import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createSliderState, createToggleState } from "./bridge";

/** Binds to the WebSliderRelay registered in PluginEditor.cpp. Values are normalised
 *  0..1 in both directions, which is what the knob wants anyway.
 *
 *  The gesture calls matter: without them the host records a jump rather than a sweep
 *  when you automate the knob, and "link to controller" misbehaves. */
export function useSliderParameter(name: string, fallback = 0) {
  const stateRef = useRef<any>(null);
  if (stateRef.current === null) stateRef.current = createSliderState(name);

  const state = stateRef.current;
  const [value, setValue] = useState(() => (state ? state.getNormalisedValue() : fallback));

  useEffect(() => {
    if (!state) return;

    const sync = () => setValue(state.getNormalisedValue());
    sync();
    const id = state.valueChangedEvent.addListener(sync);
    return () => state.valueChangedEvent.removeListener(id);
  }, [state]);

  return useMemo(
    () => ({
      value,
      setValue: (next: number) => {
        setValue(next);
        state?.setNormalisedValue(next);
      },
      gestureStart: () => state?.sliderDragStarted(),
      gestureEnd: () => state?.sliderDragEnded(),
    }),
    [state, value]
  );
}

/** Same relay, but working in the parameter's own units rather than 0..1. For an
 *  AudioParameterInt this hands back the actual integer, which is what a dropdown
 *  wants -- converting by hand invites off-by-one at the ends of the range. */
export function useSteppedParameter(name: string, min: number, max: number, fallback = min) {
  const stateRef = useRef<any>(null);
  if (stateRef.current === null) stateRef.current = createSliderState(name);

  const state = stateRef.current;
  const [value, setValue] = useState(() => (state ? state.getScaledValue() : fallback));

  useEffect(() => {
    if (!state) return;

    const sync = () => setValue(state.getScaledValue());
    sync();
    const id = state.valueChangedEvent.addListener(sync);
    return () => state.valueChangedEvent.removeListener(id);
  }, [state]);

  const set = useCallback(
    (scaled: number) => {
      const clamped = Math.min(max, Math.max(min, Math.round(scaled)));
      setValue(clamped);

      if (state) {
        state.sliderDragStarted();
        state.setNormalisedValue(max > min ? (clamped - min) / (max - min) : 0);
        state.sliderDragEnded();
      }
    },
    [state, min, max]
  );

  return [Math.round(value), set] as const;
}

/** Binds to the WebToggleButtonRelay registered in PluginEditor.cpp, so host
 *  automation and the plug-in's own state move the button too. */
export function useToggleParameter(name: string, fallback = false): [boolean, (value: boolean) => void] {
  const stateRef = useRef<any>(null);
  if (stateRef.current === null) stateRef.current = createToggleState(name);

  const state = stateRef.current;
  const [value, setValue] = useState(() => (state ? state.getValue() : fallback));

  useEffect(() => {
    if (!state) return;

    const sync = () => setValue(state.getValue());
    sync();
    const id = state.valueChangedEvent.addListener(sync);
    return () => state.valueChangedEvent.removeListener(id);
  }, [state]);

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      state?.setValue(next);
    },
    [state]
  );

  return [value, set];
}
