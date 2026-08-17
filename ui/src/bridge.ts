// @ts-ignore - JUCE ships this as plain JS, copied in by CMake from the JUCE tree.
import * as Juce from "./juce/index.js";

type AnyWindow = Window & { __JUCE__?: any };

const juceGlobal = () => (window as AnyWindow).__JUCE__;

/** True when the page is running inside JUCE's WebView, false in a plain browser. */
export const isNative: boolean =
  (juceGlobal()?.initialisationData?.__juce__functions?.length ?? 0) > 0;

/** What the detector is currently doing. `notches` are the frequencies it has parked
 *  filters on; `candidateHz` is what it is watching but has not committed to yet. */
export interface DetectorState {
  notches: number[];
  candidateHz: number;
  confidence: number;
  deepestDb: number;
  /** What the shifter is doing now, and the most it is allowed to do. */
  shiftHz: number;
  shiftMaxHz: number;
  /** Read from the parameters, not the relays -- see the note in PluginEditor.cpp. */
  power: boolean;
  noiseOn: boolean;
  noiseAmount: number;
  /** Whether the denoiser is present at all. It is compiled in, so this is false only
   *  if the build was made without it. */
  noiseReady: boolean;
  /** Licensing. Unactivated builds silence the output periodically. */
  activated: boolean;
  demoMuting: boolean;
  demoSeconds: number;
}

export const emptyDetector: DetectorState = {
  notches: [],
  candidateHz: 0,
  confidence: 0,
  deepestDb: 0,
  shiftHz: 0,
  shiftMaxHz: 0,
  power: true,
  noiseOn: true,
  noiseAmount: 0,
  noiseReady: false,
  activated: true,
  demoMuting: false,
  demoSeconds: 0,
};

export interface Frame {
  points: number[];
  peak: number;
  detector: DetectorState;
}

export const emptyFrame: Frame = { points: [], peak: 0, detector: emptyDetector };

function nativeFunction<T>(name: string, fallback: () => T) {
  if (!isNative) return async (..._args: unknown[]) => fallback();

  const fn = Juce.getNativeFunction(name);
  return (...args: unknown[]) => fn(...args) as Promise<T>;
}

export const getDetectorState = nativeFunction<DetectorState>("getDetectorState", () => emptyDetector);
export const clearNotches = nativeFunction<DetectorState>("clearNotches", () => emptyDetector);

export interface ActivationResult {
  ok: boolean;
  activated: boolean;
  /*  The server's own words, shown to the customer verbatim.

      It knows things this side cannot: that a key is on three machines already, that it
      was never sold, that it has been revoked. Each needs a different action, and
      flattening them into "invalid key" would throw away the only part that tells
      somebody what to do next.                                                        */
  message?: string;
  /** True when the request never reached the server, which is a different problem from
   *  a key being refused -- one is "check your wifi", the other "check what you typed". */
  offline?: boolean;
}

/** Activates a key against the licence server and stores the token it returns. Outside
 *  the plug-in it always fails, so the demo UI can be exercised in a browser. */
export const activate = nativeFunction<ActivationResult>(
  "activate",
  () => ({
    ok: false,
    activated: false,
    message: "Activation only works inside the plug-in.",
  })
);

export function onBackendEvent(eventId: string, callback: (payload: any) => void) {
  const backend = juceGlobal()?.backend;
  if (!backend) return () => {};

  const token = backend.addEventListener(eventId, callback);
  return () => backend.removeEventListener(token);
}

export function createToggleState(name: string) {
  if (!isNative) return null;
  return Juce.getToggleState(name);
}

export function createSliderState(name: string) {
  if (!isNative) return null;
  return Juce.getSliderState(name);
}

/** 2380 -> "2.4k", 640 -> "640" */
export function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`;
  return String(Math.round(hz));
}
