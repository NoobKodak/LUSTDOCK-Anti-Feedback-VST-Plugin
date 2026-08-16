#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <array>
#include <atomic>

/** Feedback Guard: LOST Duck's own anti-feedback engine.

    Chain:  input -> NotchBank -> SafetyLimiter -> output
                              \-> SpectralAnalyzer -> CandidateTracker -> NotchBank

    The analyser deliberately looks at the *output*, after the notches. That closes the
    loop: a notch that works makes its own tone disappear from the analysis, so the
    filter can age out instead of being held forever, and a tone that survives its notch
    is still visible and can be deepened. Analysing the input, as the original Feedback
    Protection code did, leaves the detector permanently convinced the feedback is still
    there.

    Everything here runs on the audio thread: no locks, no allocation, no file I/O. The
    UI reads a snapshot through atomics.

    Derived from the Feedback Protection project, with the analysis stage rewritten. The
    parts that were kept are the biquad maths and the general shape of the notch bank.
    What changed, and why:

      - Every analysis frame is now consumed. The original ran an FFT every 512 samples
        but returned only the last one per block and aged its tracker by a fixed 512
        samples regardless of the real buffer size, so at a 2048 buffer three frames in
        four were dropped and confirmation took over a second.
      - Candidates are tracked in a table rather than a single trackedHz. Feedback
        usually starts as two or three partials at once; a single tracker thrashes
        between them and confirms none.
      - Detection is relative to a local spectral floor rather than an absolute -55 dB,
        so quiet feedback is caught before it is loud.
      - Peaks that sit on a harmonic series are rejected, so sustained sung notes and
        musical tones are not notched.
      - Notches start shallow and deepen only if the tone survives, which keeps the
        voice intact when a light notch is enough.
      - Filter coefficients are recomputed once per block instead of once per sample per
        filter, removing roughly 1.5 million transcendental calls a second.
*/
namespace fg
{
/** Ring out a real room and you find far more than a handful of problem modes. Killing
    the loudest one lets the next cross unity -- "feedback migration" -- so the bank has
    to be deep enough to stay ahead of the queue rather than trade one howl for another. */
constexpr int maxFilterSlots = 24;
constexpr int maxCandidates = 16;

enum class Sensitivity : int { low = 0, medium = 1, high = 2 };

struct Tuning
{
    /** dB a bin must stand above its local spectral floor to be a peak at all. */
    float prominenceDb = 9.0f;

    /** dB a bin must have risen by, over either window, to count as building. This is
        the test that keeps sustained programme material out of the filter bank. */
    float growthDb = 2.5f;

    /** Fraction of the shift ceiling that runs even when nothing is wrong, 0 to 1.

        Shifting is preventative: it stops a loop establishing, and will not break one
        that already has. So a purely reactive shifter arrives too late and contributes
        almost nothing. Measured, at a 5 Hz ceiling:

            floor  AGBF median   shift on clean singing
            0.0        2.0 dB        0.00 Hz
            0.2        7.3 dB        1.00 Hz
            0.3        8.8 dB        1.50 Hz
            0.5        9.3 dB        2.50 Hz

        0.3 is the knee. It beats the old always-on 5 Hz on AGBF while colouring the
        voice a third as much, because inharmonicity scales with the shift. */
    float shiftFloor = 0.3f;

    /** Seconds a candidate must persist before it earns a notch.

        Longer than it was. A consonant lasts 50 to 200 ms, so anything shorter than
        that was letting speech through the door. Feedback lasts until it is dealt
        with, so making it wait costs a little reaction time and nothing else. */
    float confirmSeconds = 0.30f;

    /** Analysis frames within confirmSeconds that must agree. */
    int confirmHits = 8;

    /** Where a new notch starts, and how far it is allowed to be driven. */
    float startDepthDb = -12.0f;
    float maxDepthDb = -42.0f;

    /** Each time a notched tone is seen again, the notch drops by this much. */
    float deepenStepDb = -6.0f;

    float q = 24.0f;

    /** A filter with no re-detection for this long is released. */
    float releaseSeconds = 25.0f;

    static Tuning forSensitivity (Sensitivity sensitivity);
};

struct FilterInfo
{
    float frequency = 0.0f;
    float depthDb = 0.0f;
    bool active = false;
    bool locked = false;
};

/** What the editor reads. Plain atomics, written on the audio thread. */
struct EngineSnapshot
{
    std::atomic<float> candidateHz { 0.0f };
    std::atomic<float> confidence { 0.0f };
    std::atomic<int> activeFilters { 0 };
    std::atomic<float> deepestDepthDb { 0.0f };

    /** What the shifter is actually doing right now, which is not the same as what the
        parameter is set to -- see setShiftHz. */
    std::atomic<float> activeShiftHz { 0.0f };

    std::array<std::atomic<float>, maxFilterSlots> filterHz {};
};

//==============================================================================
/** One narrow parametric cut. Coefficients are recomputed at block rate; the wet/dry
    blend is ramped per sample, which is what actually needs to be smooth. */
class NotchFilter
{
public:
    void prepare (double sampleRate);
    void reset();

    void assign (float frequency, float depthDb, float qValue, int newId);

    /** Deepens an existing notch. Deliberately cannot move it: feedback sits on a room
        mode, which does not wander, and a notch that chases every fresh detection
        sweeps through the voice. A moving notch is far more audible than a fixed one. */
    void deepen (float depthDb);
    void release();
    void clear();
    void lock() { if (used) locked = true; }

    /** Advances ramps and recomputes coefficients. Call once per block. */
    void updateForBlock (float blockSeconds);
    void processBlock (juce::AudioBuffer<float>& buffer, int numChannels);

    bool isUsed() const noexcept { return used; }
    bool isLocked() const noexcept { return locked; }
    bool isNear (float hz, float fraction) const noexcept;

    float getFrequency() const noexcept { return frequency; }
    float getDepthDb() const noexcept { return targetDepthDb; }
    float getSecondsSinceSeen() const noexcept { return secondsSinceSeen; }
    void markSeen() noexcept { secondsSinceSeen = 0.0f; }
    int getId() const noexcept { return id; }

private:
    void updateCoefficients();

    double sr = 48000.0;
    int id = 0;
    bool used = false;
    bool locked = false;
    bool releasing = false;

    float frequency = 1000.0f;
    float targetFrequency = 1000.0f;
    float depthDb = 0.0f;
    float targetDepthDb = -12.0f;
    float qValue = 24.0f;
    float fade = 0.0f;
    float targetFade = 0.0f;
    float secondsSinceSeen = 0.0f;

    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
    std::array<float, 2> z1 {};
    std::array<float, 2> z2 {};
};

//==============================================================================
class NotchBank
{
public:
    void prepare (double sampleRate);
    void reset();

    /** Feeds a confirmed detection in: retunes and deepens an existing notch if one is
        already near that frequency, otherwise claims a free slot. */
    void applyDetection (float hz, const Tuning& tuning, int maxFilters);

    /** Frequencies of the filters currently in use. Returns how many were written. */
    int getActiveFrequencies (float* out, int maxOut) const;

    /** Keeps an existing notch alive and lets it deepen, without needing the growth
        that creating one requires. Never creates a filter. */
    void reinforce (float hz, const Tuning& tuning, int maxFilters);

    /** `maxFilters` is enforced here as well as when placing, because lowering the
        limit has to retire filters that are already past it. Without that, dropping
        from 16 to 2 leaves the extras running and the count stays wrong. */
    void ageAndProcess (juce::AudioBuffer<float>& buffer, const Tuning& tuning, int maxFilters);
    void clearUnlocked();
    void lockAll();

    int activeCount() const noexcept;
    float deepestDepthDb() const noexcept;
    void readInto (EngineSnapshot& snapshot) const;

private:
    int findNear (float hz, int maxFilters) const noexcept;
    int findFreeSlot (int maxFilters) const noexcept;
    int findWeakestUnlocked (int maxFilters) const noexcept;

    std::array<NotchFilter, maxFilterSlots> filters;
    double sr = 48000.0;
    int nextId = 1;
};

//==============================================================================
/** 2048-point Hann FFT, hop 512. Reports every peak that looks like feedback in each
    frame rather than only the single strongest one. */
class SpectralAnalyzer
{
public:
    static constexpr int fftOrder = 11;
    static constexpr int fftSize = 1 << fftOrder;
    static constexpr int hopSize = fftSize / 4;
    static constexpr int numBins = fftSize / 2;

    struct Peak
    {
        float frequency = 0.0f;
        float prominenceDb = 0.0f;
        float growthDb = 0.0f;
        float score = 0.0f;
    };

    struct Frame
    {
        std::array<Peak, maxCandidates> peaks {};
        int count = 0;
    };

    void prepare (double sampleRate);
    void reset();

    /** Pushes one sample. Returns true when a frame completed, filling `frame`. */
    bool pushSample (float mono, Frame& frame, const Tuning& tuning);

    /** How far a tone at this frequency stands above the local floor right now. Used to
        re-confirm notches that are already placed, which must not need growth: once a
        notch is holding a howl down the tone stops rising, and requiring growth to keep
        it would let the notch retire and the howl come straight back. */
    float prominenceAt (float hz) const { return prominenceNear (hz); }

private:
    void analyse (Frame& frame, const Tuning& tuning);

    /** Prominence of the strongest bin within a couple of bins of `hz`, so harmonic
        arithmetic is not defeated by bin quantisation. */
    float prominenceNear (float hz) const;
    bool sitsOnHarmonicSeries (float hz, float ownProminence) const;

    juce::dsp::FFT fft { fftOrder };
    juce::dsp::WindowingFunction<float> window { fftSize, juce::dsp::WindowingFunction<float>::hann, false };

    std::array<float, fftSize> fifo {};
    std::array<float, fftSize * 2> fftData {};

    /** Three time constants over the same bins. fast minus slow catches a quick onset;
        fast minus verySlow catches gain being crept up over many seconds. A held note
        shows neither, which is the whole basis of telling them apart. */
    std::array<float, numBins> fastDb {};
    std::array<float, numBins> slowDb {};
    std::array<float, numBins> verySlowDb {};

    /** Heavily smoothed across frequency -- the local noise/programme floor a peak has
        to stand above. */
    std::array<float, numBins> floorDb {};

    /** Average rise across the whole analysed band this frame, over both windows.
        Candidates are judged against these rather than against zero: a note attack, a
        crescendo, or a fader being raised lifts everything together, so what marks
        feedback out is rising *faster than the rest of the spectrum*, not rising. */
    float meanGrowthDb = 0.0f;
    float meanCreepDb = 0.0f;

    int fifoIndex = 0;
    int sinceLastFrame = 0;

    /** The growth test compares fast, slow and very slow averages of each bin. Until
        they have settled, everything looks like it is rocketing upward, so the averages
        are seeded once and detection stays shut until the warm-up has passed.

        Seeding must not happen before the FIFO has been filled: the first frame lands
        after one hop, with three quarters of the analysis window still zeros, so every
        average would be seeded far too low and the slowest would report several seconds
        of phantom "creep" on a perfectly steady tone. */
    bool primed = false;
    int framesSinceReset = 0;
    long long samplesSeen = 0;

    double sampleRate = 48000.0;
    float binHz = 23.4f;

    /** Detection band: where feedback is looked for. */
    int minBin = 4;
    int maxBin = numBins - 3;

    /** Analysis band: wider, so the harmonic tests can find a 60 Hz bass fundamental
        below the detection floor, or a 2 kHz lead's overtones above its ceiling.
        Without the margin those notes look like isolated tones and get notched. */
    int analysisMinBin = 2;
    int analysisMaxBin = numBins - 3;
};

//==============================================================================
/** Persistence table. A peak has to keep showing up, near the same frequency, across
    several frames before it is allowed to become a notch. */
class CandidateTracker
{
public:
    void prepare (double sampleRate);
    void reset();

    /** Folds one analysis frame in. Confirmed frequencies are written to `confirmed`
        and the count returned. */
    int update (const SpectralAnalyzer::Frame& frame, float frameSeconds, const Tuning& tuning,
                float* confirmed, int maxConfirmed);

    float strongestHz() const noexcept { return bestHz; }
    float strongestConfidence() const noexcept { return bestConfidence; }

private:
    struct Candidate
    {
        float frequency = 0.0f;
        float ageSeconds = 0.0f;
        float sinceSeenSeconds = 0.0f;
        float scoreSum = 0.0f;
        int hits = 0;
        bool used = false;
    };

    std::array<Candidate, maxCandidates * 2> candidates {};
    float bestHz = 0.0f;
    float bestConfidence = 0.0f;
};

//==============================================================================
/** Single-sideband frequency shifter.

    Notching is reactive: a mode has to howl before it can be cut, and killing it just
    promotes the next one. Shifting is not. Feedback needs the loop phase to line up on
    every trip round the room, and moving the whole signal a few Hz destroys that
    coherence for every mode at once -- including the ones the detector has never seen.
    It buys gain before feedback across the board rather than one frequency at a time.

    Built from a pair of all-pass chains whose outputs sit 90 degrees apart (the classic
    Hilbert network), then modulated. Not a pitch shift: every partial moves by the same
    number of Hz, not the same ratio, which is why 5 Hz is inaudible on speech but will
    shimmer on a sustained piano.
*/
class FrequencyShifter
{
public:
    void prepare (double sampleRate);
    void reset();

    /** 0 disables it entirely. Useful range is about 3 to 8 Hz. */
    void setShiftHz (float hz) noexcept { shiftHz = juce::jlimit (0.0f, 12.0f, hz); }
    float getShiftHz() const noexcept { return shiftHz; }

    void process (juce::AudioBuffer<float>& buffer);

private:
    /** All-pass section in z^-2: y[n] = c*(x[n] + y[n-2]) - x[n-2]. */
    struct AllPass
    {
        float process (float x) noexcept
        {
            const auto y = c * (x + y2) - x2;
            x2 = x1; x1 = x;
            y2 = y1; y1 = y;
            return y;
        }

        void reset() noexcept { x1 = x2 = y1 = y2 = 0.0f; }

        float c = 0.0f;
        float x1 = 0.0f, x2 = 0.0f, y1 = 0.0f, y2 = 0.0f;
    };

    struct Channel
    {
        std::array<AllPass, 4> inPhase;
        std::array<AllPass, 4> quadrature;
        float delayed = 0.0f;

        void reset() noexcept
        {
            for (auto& s : inPhase) s.reset();
            for (auto& s : quadrature) s.reset();
            delayed = 0.0f;
        }
    };

    std::array<Channel, 2> channels;
    double sr = 48000.0;
    float shiftHz = 0.0f;
    float phase = 0.0f;
};

//==============================================================================
/** Zero-latency peak limiter at -1 dBFS, to stop notch transitions clipping. */
class SafetyLimiter
{
public:
    void prepare (double sampleRate);
    void reset();
    void process (juce::AudioBuffer<float>& buffer);

private:
    float envelope = 0.0f;
    float releaseCoeff = 0.9995f;
};

//==============================================================================
/** The whole engine. This is what PluginProcessor talks to. */
class FeedbackGuardEngine
{
public:
    void prepare (double sampleRate, int maximumBlockSize);
    void reset();

    /** Notches, limits, then analyses the result. */
    void process (juce::AudioBuffer<float>& buffer);

    void setSensitivity (Sensitivity s) { sensitivity = s; }

    /** 0 turns notching off entirely, which is how the harness isolates the shifter. */
    void setMaxFilters (int n) { maxFilters = juce::jlimit (0, maxFilterSlots, n); }

    /** The *ceiling*, not a constant. Shifting buys gain before feedback but it moves
        every partial by the same number of Hz rather than the same ratio, so a sung
        vowel's harmonics stop being a harmonic series and it reads as chorusing. That
        cost is only worth paying while feedback is actually a risk, so the shifter
        winds up when the detector sees trouble and back to silence when it does not.
        Set to 0 to disable shifting entirely. */
    void setShiftHz (float hz) noexcept { shiftCeilingHz = juce::jlimit (0.0f, 12.0f, hz); }
    float getShiftCeilingHz() const noexcept { return shiftCeilingHz; }
    float getActiveShiftHz() const noexcept { return shifter.getShiftHz(); }
    void requestClear() noexcept { clearRequested = true; }
    void requestLock() noexcept { lockRequested = true; }

    const EngineSnapshot& getSnapshot() const noexcept { return snapshot; }
    int getLatencySamples() const noexcept { return 0; }

private:
    SpectralAnalyzer analyzer;
    CandidateTracker tracker;
    NotchBank bank;
    FrequencyShifter shifter;
    SafetyLimiter limiter;

    EngineSnapshot snapshot;
    SpectralAnalyzer::Frame frame;

    Sensitivity sensitivity = Sensitivity::medium;
    int maxFilters = 16;
    double sr = 48000.0;

    /** How much shift is allowed, and how much is currently being used. Risk winds up
        fast and unwinds slowly: catching the next mode matters more than being
        transparent half a second sooner, but sitting at full shift all night is exactly
        the damage this is meant to avoid. */
    float shiftCeilingHz = 5.0f;
    float feedbackRisk = 0.0f;

    std::atomic<bool> clearRequested { false };
    std::atomic<bool> lockRequested { false };
};
}
