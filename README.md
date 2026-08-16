# LOST Duck Anti Feedback

A VST3 / Standalone anti-feedback effect for live vocals. JUCE 8 audio engine, React +
TypeScript UI rendered in JUCE's `WebBrowserComponent` (WebView2). Windows x64.

The feedback suppression is its own DSP, compiled in. Nothing is hosted, nothing is
licensed, nothing phones home, and there is no external file to lose.

---

## Build

```powershell
cmake --preset vs
cmake --build --preset vs --config Release
```

CMake fetches JUCE 8.0.15 via CPM, runs `npm install` and `npm run build` in `ui/`,
compiles the React output into `BinaryData`, and drops the plug-in in
`plugin\LOST Duck Anti Feedback.vst3`.

`NEEDS_WEBVIEW2` links WebView2 statically, which needs Microsoft's NuGet package in
`.dist\nuget\`. `.dist` is disposable, so on a fresh checkout configure will stop with
*"WebView2 wasn't found in the local NuGet folder"*. Fetch it once:

```powershell
Register-PackageSource -provider NuGet -name nugetRepository -location https://www.nuget.org/api/v2
Install-Package Microsoft.Web.WebView2 -Scope CurrentUser -RequiredVersion 1.0.3485.44 -Source nugetRepository
```

then copy the `Microsoft.Web.WebView2.1.0.3485.44` folder into `.dist\nuget\`, or point
`JUCE_WEBVIEW2_PACKAGE_LOCATION` at wherever it already lives.

To also install into the system scan folder:

```powershell
cmake --preset vs -DLOSTDUCK_INSTALL_LOCAL=ON
```

Close your DAW first. A host that has the plug-in loaded keeps the DLL memory-mapped,
and the install will fail with "access denied" that has nothing to do with permissions.

### Live UI development

```powershell
cmake --preset dev
cmake --build --preset dev
```

then, in a second terminal:

```powershell
npm --prefix ui run dev
```

The `dev` preset points the WebView at `http://localhost:5173`, so editing anything
under `ui/src` hot-reloads in the Standalone build with no C++ rebuild.

---

## The engine

`source/FeedbackGuard.cpp`. Signal flow:

```
input -> NotchBank -> FrequencyShifter -> SafetyLimiter -> output
                                      \-> SpectralAnalyzer -> CandidateTracker -> NotchBank
```

Two mechanisms, and the second does more work than the first.

**Frequency shifting** moves the whole signal up a few Hz by single-sideband modulation
(a Hilbert all-pass pair, then a modulator). Feedback needs the loop phase to line up on
every trip round the room; a few Hz of offset destroys that coherence for *every* mode
at once, including ones the detector has never seen. It is not a pitch shift -- every
partial moves the same number of Hz, not the same ratio -- which is why 5 Hz is
inaudible on speech but can shimmer on a sustained piano. Measured sideband rejection is
30 dB with the carrier 35 dB down.

**Notching** then handles whatever still gets through.

A 2048-point Hann FFT with a 512 hop looks for peaks that stand above the *local
spectral floor*, are one or two bins wide, are not part of a harmonic series, and are
either growing or already towering. Peaks that keep reappearing near the same frequency
across several frames earn a notch. Notches start at −12 dB and only deepen if the tone
survives, so a light cut is used where a light cut is enough.

Reported latency is zero. Notches are minimum phase and the limiter is zero-latency,
which matters when this sits on a vocal feeding a stage monitor.

Two design choices worth knowing:

**The analyser looks at the output, not the input.** That closes the loop: a notch that
works makes its own tone vanish from the analysis, so the filter can age out after 25 s
instead of being held forever, and a tone that survives its notch is still visible and
gets driven deeper.

**Detection is gated on growth.** Feedback builds; a held note does not. This is what
keeps a sustained sung note out of the filter bank. A `slowDb` average per bin needs
about 0.8 s to settle, so detection stays shut during that warm-up — otherwise every bin
looks like it is rocketing upward from silence and the bank fills instantly.

### Relationship to the Feedback Protection project

The biquad maths and the general shape of the notch bank came from
`..\Feedback Protection`. The analysis stage was rewritten, because that version did not
work on a real microphone. What was wrong with it, all of it measured rather than
assumed:

- `pushSamples` ran an FFT every 512 samples but returned only the last result per
  block, and aged its tracker by a fixed 512 samples regardless of the real buffer size.
  At a 2048 buffer, three detections in four were discarded and confirmation took over a
  second.
- `CandidateTracker` held a single `trackedHz`. Feedback normally starts as two or three
  partials at once, so it thrashed between them, reset its confirmation count each time
  the peak jumped, and confirmed nothing.
- The level gate was an absolute −55 dB after normalising by FFT size, so feedback was
  only caught once it was already loud.
- Harmonic rejection checked `f/2` and `f/3` only, which misses the 5th and 7th
  harmonics of a voice — exactly the partials that get notched by mistake.
- `updateCoefficients()` ran once per sample per filter: a `pow`, `sin`, `cos` and a
  divide, eight times a sample, about 1.5 million transcendental calls a second.

Its test suite passed throughout, because every test fed a pure sine into one component
in isolation. Nothing tested the whole chain, and nothing tested a feedback loop.

## Measuring it

```powershell
cmake --preset vs -DLOSTDUCK_BUILD_HARNESS=ON
cmake --build --preset vs --config Release --target LostDuckDspHarness
.\.dist\build\LostDuckDspHarness_artefacts\Release\LostDuckDspHarness.exe
```

`tools/DspHarness.cpp` simulates a real acoustic loop — microphone into the plug-in,
into a PA, through a room of three high-Q modes, back into the microphone — and ramps
the loop gain past unity so it genuinely howls. It compares bypass, limiter-only and the
full engine, then runs a clean voice through on its own.

Current numbers, against a nine-mode room from 312 Hz to 6840 Hz:

| condition | worst level at the mic | notches used |
|---|---|---|
| bypass | +18.3 dBFS — runaway | — |
| limiter only | +2.8 dBFS — full-scale howl, merely clamped | — |
| notches only, cap 4 | +0.9 dBFS | 4 |
| notches only, cap 6 / 16 / 24 | +0.8 dBFS | 6 |
| shift 8 Hz, **no notches** | −11.1 dBFS | 0 |
| **shift 5 Hz + notches** | **−11.6 dBFS** | **4** |
| shift 8 Hz + notches | −11.2 dBFS | 3 |

| clean voice, no feedback | |
|---|---|
| level change | −0.00 dB |
| notches placed | 0 |

| cost | |
|---|---|
| 60 s of stereo | 0.47 s, 128x realtime, 0.78% of one core |

Three things that table settles:

- **The limiter is not doing the work.** Its row is a full-scale howl that has merely
  been clamped, which is why it is measured separately.
- **Bank depth is not the limit.** Raising the cap from 6 to 24 changes nothing —
  the same 6 filters get used. Notching is reactive: each mode has to howl before it can
  be cut, and killing one promotes the next. More slots do not make it less reactive.
- **The shifter beats the entire notch bank on its own**, and combined they need
  *fewer* filters (4 instead of 6), so less of the voice is removed.

---

## Parameters

| ID | Name | Range | Default |
|---|---|---|---|
| `power` | Power | bool, shown as ON / OFF | true |
| `shift` | Frequency Shift | 0 – 12 Hz, 0 reads OFF | 5 Hz |

`power` is the orange button. `shift` is not on the front panel — the casing has one
button — but it changes the sound, so it is automatable, visible in the host, and shown
on the screen whenever it is running. Set it to 0 for sustained tonal sources, where a
few Hz of offset can shimmer; on speech and most vocals it is inaudible.

The notch bank holds 24 filters with 16 usable by default. That is headroom, not a
recommendation — the measurements above show depth is not the limiting factor.

Sensitivity and maximum filter count live in `fg::Tuning` and are plumbed through
`FeedbackGuardEngine::setSensitivity` / `setMaxFilters`; they are simply not exposed as
parameters yet. Adding them is a line each in `createLayout()`.

## Layout

The UI is authored in a fixed **1430 × 795** design space — the pixel size of
`assets/casing.svg` — and scaled with a single CSS `transform: scale()`. The container
is measured with a `ResizeObserver`, so the fit stays correct under any Windows display
scaling. The editor opens at 715 × 397 and is resizable with the aspect ratio locked.

| Element | Position (design px) |
|---|---|
| Casing | 0, 0 — 1430 × 795 |
| Screen | 69, 57 — 579 × 532, corner radius 230 |
| Button (visible) | centred on 1168.5, 312.5 |
| Button (`button.svg` canvas) | 1065.5, 206.7 — 227.6 × 232.4 |

The two button rows differ because `button.svg` is an ellipse flush to the left edge of
its canvas with the whole drop shadow padded onto the right and bottom. The casing
already has the button painted into it, so the overlay has to land on that copy exactly;
the placement was solved by locating the orange dome in both PNGs rather than estimated.
The derivation is written out in `ui/src/styles.css`.

## The screen

A real oscilloscope. `PluginProcessor` writes the output into a 2048-sample ring; the
editor timer reads it at 30 Hz, aligns the window to a rising zero crossing so a steady
tone stands still, decimates it to 180 signed peaks and pushes it to the UI. On silence
the trace crossfades into a slow idle sine so the screen is never a dead flat line.

The trace turns amber and the status reads SUPPRESSING once notches are placed, and the
frequencies appear across the middle of the screen. Clicking the notch count clears
every unlocked filter.

## Layout of the repo

```
CMakeLists.txt          fetches JUCE, builds the UI, defines the plug-in
CMakePresets.json       vs / dev presets
cmake/CPM.cmake         CPM bootstrap
assets/                 casing.svg, button.svg (shared with the UI as its publicDir)
plugin/                 build output lands here
source/
  PluginProcessor.*     APVTS, power, scope ring
  PluginEditor.*        WebView, power relay, native functions, 30 Hz push to the UI
  FeedbackGuard.*       the anti-feedback engine
  WebResourceProvider.* serves ui/dist out of BinaryData
tools/DspHarness.cpp    offline acoustic-loop measurement
ui/                     React app (Vite)
  src/layout.ts         design space and screen geometry
  src/components/       Scope (canvas oscilloscope), PowerButton
  src/juce/             JUCE's frontend bridge, copied in by CMake -- do not edit
```

## Known limits

- Windows only, by design (WebView2). Needs the WebView2 runtime, present on any current
  Windows 11.
- A room mode that lands within about half a percent of a strong vocal harmonic is
  protected by the harmonic rejection and will be caught late or not at all. That is the
  deliberate side of the trade: notching the singer is worse.
- Frequency shifting moves every partial by the same number of Hz, so it puts harmonics
  slightly out of ratio. Speech and most vocals do not show it; sustained piano, organ
  and solo strings can shimmer. Set `shift` to 0 on those sources.
- Detection is still reactive: a new mode has to start howling before it is notched.
  Acting on the growth *trajectory* rather than the confirmed peak would cut reaction
  from about 160 ms to about 50 ms, but only safely alongside a trained classifier to
  hold false positives at zero.
- Nothing here fixes microphone placement, speaker placement or gain structure, and it
  cannot remove broadband howl without affecting the vocal.
- `.dist/` holds the build tree, the JUCE checkout and the WebView2 SDK; it is
  disposable and can be deleted to force a clean fetch.

## Licence note

JUCE 8 is AGPLv3 or commercial. If you distribute a build without a commercial JUCE
licence, AGPLv3 obliges you to make the complete corresponding source available to your
users. React and Vite are MIT. The artwork and the DSP are yours.
