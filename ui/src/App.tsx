import { useEffect, useRef, useState } from "react";

import { ActivationPanel } from "./components/ActivationPanel";
import { NoiseKnob } from "./components/NoiseKnob";
import { NoiseSwitch } from "./components/NoiseSwitch";
import { PowerButton } from "./components/PowerButton";
import { Scope } from "./components/Scope";
import {
  clearNotches,
  emptyFrame,
  formatHz,
  getDetectorState,
  onBackendEvent,
  type DetectorState,
  type Frame,
} from "./bridge";
import { design } from "./layout";
import { useSliderParameter, useSteppedParameter, useToggleParameter } from "./useParameter";

const maxNotchOptions = Array.from({ length: 16 }, (_, i) => i + 1);

export default function App() {
  // The relays are how a click reaches the parameter, and how host automation reaches
  // the UI. Their reported value is deliberately not used for display -- see below.
  const [, setPower] = useToggleParameter("power", true);
  const [, setNoiseEnabled] = useToggleParameter("noiseOn", true);
  const noise = useSliderParameter("noise", 0);
  const [maxNotches, setMaxNotches] = useSteppedParameter("maxNotches", 1, 16, 6);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const pickerListRef = useRef<HTMLDivElement>(null);
  const currentOptionRef = useRef<HTMLButtonElement>(null);

  // Centre the current value when the list opens, so 16 is not off-screen below.
  useEffect(() => {
    if (!pickerOpen) return;

    currentOptionRef.current?.scrollIntoView({ block: "center" });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

  // Toggle positions as the audio engine actually has them. A relay's JS side starts
  // false and only becomes true after an async round trip, so trusting it for display
  // lets the picture disagree with the sound. These are set optimistically on click and
  // corrected by the engine on the next frame, so a failed write shows up immediately
  // instead of leaving the UI quietly lying.
  const [on, setOn] = useState(true);
  const [noiseOn, setNoiseOn] = useState(true);

  // The frame arrives 30x a second. Keeping it in a ref means only the canvas sees it;
  // React renders when the readouts below actually change.
  const frameRef = useRef<Frame>(emptyFrame);
  const [detector, setDetector] = useState<DetectorState>(emptyFrame.detector);

  useEffect(() => {
    const adopt = (state: DetectorState) => {
      setOn(state.power);
      setNoiseOn(state.noiseOn);
    };

    getDetectorState().then((state) => {
      frameRef.current = { ...frameRef.current, detector: state };
      setDetector(state);
      adopt(state);
    });

    const off = onBackendEvent("lostduck:frame", (payload) => {
      const next: DetectorState = payload?.detector ?? emptyFrame.detector;

      frameRef.current = {
        points: Array.isArray(payload?.points) ? payload.points : [],
        peak: payload?.peak ?? 0,
        detector: next,
      };

      // Cheap at 30 Hz: React bails out when the value has not changed.
      adopt(next);
    });

    // Notch frequencies move slowly, so polling the ref a few times a second is plenty
    // and keeps React out of the audio frame rate.
    const readout = window.setInterval(() => {
      setDetector((previous) => {
        const next = frameRef.current.detector;
        const same =
          previous.notches.length === next.notches.length &&
          previous.shiftHz === next.shiftHz &&
          previous.noiseReady === next.noiseReady &&
          previous.notches.every((hz, i) => Math.abs(hz - next.notches[i]) < 1);

        return same ? previous : next;
      });
    }, 200);

    return () => {
      off();
      window.clearInterval(readout);
    };
  }, []);

  // Measuring the viewport element rather than window.innerWidth keeps the fit correct
  // no matter how WebView2 maps CSS pixels onto the host window's DPI.
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const applyScale = () => {
      const width = element.clientWidth;
      if (width > 0) element.style.setProperty("--ui-scale", String(width / design.width));
    };

    applyScale();
    const observer = new ResizeObserver(applyScale);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Big percent readout while the knob is moving. The casing prints 0 and 100 either
  // side of the knob but no numbers in between, so without this you are guessing.
  const [showNoiseValue, setShowNoiseValue] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);

  const flashNoiseValue = () => {
    setShowNoiseValue(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShowNoiseValue(false), 900);
  };

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const togglePower = (value: boolean) => {
    setOn(value);
    setPower(value);
  };

  const toggleNoise = (value: boolean) => {
    setNoiseOn(value);
    setNoiseEnabled(value);
  };

  const count = detector.notches.length;
  const status = !on ? "BYPASSED" : count > 0 ? "SUPPRESSING" : "LISTENING";

  return (
    <div className="viewport" ref={viewportRef}>
      <div className="stage">
        <img className="casing" src="newcasing.svg" alt="" draggable={false} />

        <div className="screen">
          <Scope frameRef={frameRef} on={on} />

          <div className="hud">
            <div className="hud-title">ANTI FEEDBACK AI</div>

            {/* Top right, and only while unlicensed. Clicking it is the way in. */}
            {!detector.activated && !activateOpen && (
              <button
                type="button"
                className={`hud-demo ${detector.demoMuting ? "is-muting" : ""}`}
                onClick={() => setActivateOpen(true)}
                title="Demo mode - click to enter your activation key"
              >
                DEMO
              </button>
            )}

            {/*  Says what the DEMO badge cannot.

                A red pill in the corner tells somebody they are not licensed; it does
                not tell them that activating needs a connection. That matters because of
                where this plug-in gets used: a laptop carried to a venue, often with no
                wifi worth the name, sometimes minutes before a set. Finding out then is
                the worst moment to find out, so it is said on the first screen, before
                anybody has typed anything -- along with the reassurance that it is asked
                for exactly once.

                The whole strip opens the key entry, so the sentence explaining what is
                needed is also the way to do it.                                        */}
            {!detector.activated && !activateOpen && (
              <button
                type="button"
                className="hud-firstrun"
                onClick={() => setActivateOpen(true)}
              >
                <span className="hud-firstrun-head">ONLINE ACTIVATION REQUIRED</span>
                <span className="hud-firstrun-sub">
                  Connect to the internet once to activate this computer. It runs offline
                  after that.
                </span>
              </button>
            )}

            {activateOpen && (
              <ActivationPanel
                onClose={() => setActivateOpen(false)}
                onActivated={() => {
                  setActivateOpen(false);
                  getDetectorState().then(setDetector);
                }}
              />
            )}

            {on && count > 0 && (
              <ul className="hud-notches">
                {detector.notches.map((hz, i) => (
                  <li key={`${i}-${Math.round(hz)}`}>{formatHz(hz)}</li>
                ))}
              </ul>
            )}

            <div className="hud-foot">
              <span className={`hud-status ${on ? (count > 0 ? "is-working" : "is-live") : ""}`}>
                <i className="lamp" aria-hidden="true" />
                {status}
              </span>

              {/* The switch is at the bottom of the casing; this puts its position on
                  the screen where the eye already is. */}
              <img
                className={`hud-noise-indicator ${noiseOn ? "is-on" : "is-off"}`}
                src={noiseOn ? "indecator noise on.svg" : "indecator noise off.svg"}
                alt={noiseOn ? "Noise reduction on" : "Noise reduction off"}
                title={noiseOn ? "Noise reduction ON" : "Noise reduction OFF"}
                draggable={false}
              />

              {/* Used out of allowed. Every notch takes something out of the voice, so
                  the ceiling is worth seeing next to the count rather than buried. */}
              <button
                type="button"
                className="hud-count"
                title={
                  on
                    ? `${count} of ${maxNotches} notches in use. Click to set the limit.`
                    : "Bypassed"
                }
                onClick={() => on && setPickerOpen(true)}
              >
                {on ? `${count}/${maxNotches} NOTCH` : "--"}
              </button>
            </div>

            {/* Takes over the screen the same way the noise readout does. Scrolls
                vertically; the current value is centred when it opens. */}
            {pickerOpen && (
              <div className="hud-picker" role="dialog" aria-label="Maximum notches">
                <div className="hud-picker-label">MAX NOTCH</div>

                <div className="hud-picker-list" ref={pickerListRef}>
                  {maxNotchOptions.map((n) => (
                    <button
                      key={n}
                      type="button"
                      ref={n === maxNotches ? currentOptionRef : undefined}
                      className={`hud-picker-item ${n === maxNotches ? "is-current" : ""}`}
                      onClick={() => {
                        setMaxNotches(n);
                        setPickerOpen(false);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>

                <div className="hud-picker-actions">
                  <button
                    type="button"
                    className="hud-picker-close"
                    onClick={() => {
                      clearNotches().then(setDetector);
                      setPickerOpen(false);
                    }}
                    disabled={count === 0}
                    title="Drop every notch and start listening again"
                  >
                    CLEAR
                  </button>

                  <button
                    type="button"
                    className="hud-picker-close"
                    onClick={() => setPickerOpen(false)}
                  >
                    CLOSE
                  </button>
                </div>
              </div>
            )}

            {/* Reads over the waveform while the knob moves, then fades. */}
            {showNoiseValue && (
              <div className="hud-noise-value">
                <span className="hud-noise-value-number">{Math.round(noise.value * 100)}</span>
                <span className="hud-noise-value-unit">%</span>
                <span className="hud-noise-value-label">NOISE</span>
              </div>
            )}

            {/* The shift changes the sound, so it never runs silently -- the readout
                shows what it is actually doing rather than what it is allowed to do. */}
            {on && (
              <div className="hud-shift">
                {/* Live value, not the setting. It sits at 0 on a clean vocal and winds
                    up only when feedback is a risk, so seeing it move is the point. */}
                {detector.shiftMaxHz <= 0
                  ? "SHIFT OFF"
                  : detector.shiftHz > 0.05
                    ? `SHIFT ${detector.shiftHz.toFixed(1)} Hz`
                    : "SHIFT IDLE"}
                {"   ·   "}
                {/* Names the control, not the library behind it. */}
                {!noiseOn
                  ? "NOISE OFF"
                  : detector.noiseReady
                    ? `NOISE ${Math.round(noise.value * 100)}%`
                    : "NOISE N/A"}
              </div>
            )}
          </div>

          <div className="screen-glass" aria-hidden="true" />
        </div>

        <PowerButton on={on} onToggle={togglePower} />

        <NoiseKnob
          value={noise.value}
          disabled={!noiseOn}
          onChange={(next) => {
            flashNoiseValue();
            noise.setValue(next);
          }}
          onGestureStart={() => {
            flashNoiseValue();
            noise.gestureStart();
          }}
          onGestureEnd={noise.gestureEnd}
        />

        <NoiseSwitch on={noiseOn} onToggle={toggleNoise} />
      </div>
    </div>
  );
}
