#include "SpectralDenoiser.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>

namespace
{
/** The most the stage may pull the signal down, however far the knob is turned.

    Twenty decibels is a lot of noise reduction and still leaves everything audible. The
    knob therefore runs from "no reduction" to "20 dB of reduction" rather than from
    "dry" to "whatever the estimator decided" -- which is not a musical range to hand
    anybody, and is exactly how the previous denoiser managed to silence a held note. */
constexpr float maxReductionDb = -20.0f;

/** Decision-directed smoothing for the a-priori SNR (Ephraim & Malah).

    This single number decides whether the output sounds like noise reduction or like a
    broken radio. Estimating the SNR from the current frame alone makes the gain jump
    between frames, and random per-bin gain jumps are exactly what "musical noise" is --
    little tones warbling in the background. Leaning 98% on the previous frame's answer
    keeps the gain steady over time, at the cost of one frame of reaction. */
constexpr float snrSmoothing = 0.98f;

/*  Doblinger's continuous minimum tracker. The noise floor is the running minimum of
    the smoothed power in each band: even a busy vocal leaves gaps in every band over a
    second or two, and the noise does not.                                            */
constexpr float minimumDecay = 0.998f;
constexpr float minimumLook = 0.96f;

/** Power smoothing ahead of the minimum tracker. */
constexpr float powerSmoothing = 0.8f;

/** How far above its own tracked minimum a band must sit to count as signal rather than
    noise. Low enough to keep the estimate current, high enough that quiet consonants do
    not get absorbed into it. */
constexpr float speechThreshold = 2.8f;

/** How fast the noise estimate follows a band once that band is judged to be noise. */
constexpr float noiseFollow = 0.92f;

/** Floor on the a-priori SNR, which is also the floor on how hard the gain can dive in
    any one frame. Without it a silent band drives the gain to zero and back, which
    chatters. */
constexpr float minimumPrior = 0.003f;

/*  ---------------------------------------------------------------------------
    Tonal protection, and why the thing does not work without it.

    Everything above tracks each band over *time*: the noise floor is the level a band
    keeps coming back down to. That is sound reasoning for hiss, and it is completely
    defeated by a held note. Play a steady tone for two seconds and the tracker watches
    a band that never comes down, concludes the floor is up there, and deletes it. The
    first build of this measured -17.5 dB on every source it was given, voice included,
    because a sustained vowel and a sustained hiss look identical to a clock.

    A tone and a hiss are only different if you look *across* frequency instead. Noise
    is broad and smooth; a note is a narrow spike standing well clear of the spectrum
    around it. So each band is compared with the floor of its own neighbourhood, and a
    band that stands proud of its neighbours is left alone however long it has been
    there.

    The honest cost of this: mains hum is also a narrow spike, so it is also protected.
    Hum is a notch's job -- and this plug-in already has a bank of them -- whereas a
    sustained note eaten by the noise control is unrecoverable. That is the trade, taken
    deliberately.                                                                     */

/** How fast the across-frequency floor tracker may climb, per bin. 1.6 is about 2 dB a
    bin, so it escapes a 20 dB peak in roughly five bins -- 470 Hz at 48 kHz, wide enough
    to sit under a mainlobe and narrow enough to follow the shape of real noise. */
constexpr float floorRisePerBin = 1.6f;

/** Power ratio of a band to its neighbourhood floor. Below the first it is part of a
    broad spectrum and gets the full treatment; above the second it is a tone and is
    left alone; between, it fades. Ratios, not dB: 4 is 6 dB and 16 is 12 dB. */
constexpr float tonalLow = 4.0f;
constexpr float tonalHigh = 16.0f;

/** A tone is not one bin -- windowing spreads it over a small mainlobe. Protection earned
    at the summit is spread sideways over about three bins so the shoulders go with it. */
constexpr float protectSpreadPerBin = 0.34f;

//------------------------------------------------------------------------------
/** Half-octave bank. Q is the value that makes a peaking filter's -3 dB points land
    half an octave apart, so neighbours meet where they have each fallen by half. */
constexpr float bandsPerOctave = 2.0f;
constexpr float bandQ = 2.871f;
/** Below a singer's lowest useful content, so stage rumble and floor thump have bands of
    their own to be pushed down in rather than falling off the bottom of the bank. */
constexpr float lowestBandHz = 25.0f;

/** How fast the band gains may move, as a time constant. The estimate underneath is
    already heavily smoothed; this is the last guard against a biquad's coefficients
    being yanked between blocks, which is audible as a click. */
constexpr float bandSlewSeconds = 0.05f;

/** Room either side of the nominal range for the solved settings. The solve can ask one
    filter for more than the target depth so its neighbours can pull back; that is
    legitimate, but it is bounded so a badly conditioned solve cannot run away. */
constexpr float solvedFloorDb = -32.0f;
constexpr float solvedCeilingDb = 8.0f;

constexpr float tiny = 1.0e-12f;

/** Smooth 0..1 ramp between two thresholds, on a log scale so it reads in decibels. */
inline float ramp (float value, float low, float high)
{
    const auto t = std::log (juce::jmax (value, tiny) / low) / std::log (high / low);
    return juce::jlimit (0.0f, 1.0f, t);
}

//------------------------------------------------------------------------------
struct Biquad
{
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
    float x1 = 0.0f, x2 = 0.0f, y1 = 0.0f, y2 = 0.0f;

    void clearState() noexcept { x1 = x2 = y1 = y2 = 0.0f; }

    /** RBJ peaking EQ. */
    void setPeaking (double rate, float centreHz, float q, float gainDb) noexcept
    {
        const auto a = std::pow (10.0f, gainDb / 40.0f);
        const auto w0 = juce::MathConstants<float>::twoPi * centreHz / (float) rate;
        const auto cosw = std::cos (w0);
        const auto alpha = std::sin (w0) / (2.0f * q);

        const auto a0 = 1.0f + alpha / a;

        b0 = (1.0f + alpha * a) / a0;
        b1 = (-2.0f * cosw) / a0;
        b2 = (1.0f - alpha * a) / a0;
        a1 = (-2.0f * cosw) / a0;
        a2 = (1.0f - alpha / a) / a0;
    }

    /*  The two ends of the bank are shelves, not peaks.

        A peaking filter returns to 0 dB either side of its centre, so a bank made only
        of peaks does nothing at all above its highest centre or below its lowest. With
        the top centre at 18 kHz that leaves everything from there to Nyquist untouched
        -- about a quarter of the power of broadband hiss, which is why the first version
        of this managed only 7 dB of hiss removal while every band centre was reading a
        correct 20. Shelves carry the decision out to the edges.                       */
    void setShelf (double rate, float cornerHz, float gainDb, bool high) noexcept
    {
        const auto a = std::pow (10.0f, gainDb / 40.0f);
        const auto w0 = juce::MathConstants<float>::twoPi * cornerHz / (float) rate;
        const auto cosw = std::cos (w0);
        const auto alpha = std::sin (w0) * 0.5f * juce::MathConstants<float>::sqrt2;
        const auto twoSqrtAlpha = 2.0f * std::sqrt (a) * alpha;

        const auto sign = high ? 1.0f : -1.0f;

        const auto a0 = (a + 1.0f) - sign * (a - 1.0f) * cosw + twoSqrtAlpha;

        b0 =  a * ((a + 1.0f) + sign * (a - 1.0f) * cosw + twoSqrtAlpha) / a0;
        b1 = -sign * 2.0f * a * ((a - 1.0f) + sign * (a + 1.0f) * cosw) / a0;
        b2 =  a * ((a + 1.0f) + sign * (a - 1.0f) * cosw - twoSqrtAlpha) / a0;
        a1 =  sign * 2.0f * ((a - 1.0f) - sign * (a + 1.0f) * cosw) / a0;
        a2 = ((a + 1.0f) - sign * (a - 1.0f) * cosw - twoSqrtAlpha) / a0;
    }

    forcedinline float processSample (float in) noexcept
    {
        const auto out = b0 * in + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;

        x2 = x1; x1 = in;
        y2 = y1; y1 = out;

        return out;
    }

    /** Magnitude at a frequency, in dB. Used only while building the interaction map. */
    float responseDb (double rate, float atHz) const noexcept
    {
        const auto w = juce::MathConstants<double>::twoPi * atHz / rate;
        const std::complex<double> z (std::cos (-w), std::sin (-w));
        const auto num = (double) b0 + (double) b1 * z + (double) b2 * z * z;
        const auto den = 1.0 + (double) a1 * z + (double) a2 * z * z;

        return (float) (20.0 * std::log10 (std::max (std::abs (num / den), 1.0e-9)));
    }
};

/** One place that decides what each element of the bank is, so the matrix that is built
    at prepare() and the filters that run at playback can never disagree about it. */
void configureBand (Biquad& f, double rate, const std::vector<float>& centres,
                    int index, float gainDb) noexcept
{
    const auto last = (int) centres.size() - 1;

    if (index == 0)
        f.setShelf (rate, centres[0], gainDb, false);
    else if (index == last)
        f.setShelf (rate, centres[(size_t) last], gainDb, true);
    else
        f.setPeaking (rate, centres[(size_t) index], bandQ, gainDb);
}

/** Gauss-Jordan with partial pivoting. n is small (about 20) and this runs once. */
bool invertInPlace (std::vector<float>& m, int n)
{
    std::vector<float> inv ((size_t) (n * n), 0.0f);

    for (int i = 0; i < n; ++i)
        inv[(size_t) (i * n + i)] = 1.0f;

    for (int col = 0; col < n; ++col)
    {
        int pivot = col;

        for (int r = col + 1; r < n; ++r)
            if (std::abs (m[(size_t) (r * n + col)]) > std::abs (m[(size_t) (pivot * n + col)]))
                pivot = r;

        if (std::abs (m[(size_t) (pivot * n + col)]) < 1.0e-9f)
            return false;

        if (pivot != col)
            for (int c = 0; c < n; ++c)
            {
                std::swap (m[(size_t) (col * n + c)], m[(size_t) (pivot * n + c)]);
                std::swap (inv[(size_t) (col * n + c)], inv[(size_t) (pivot * n + c)]);
            }

        const auto d = m[(size_t) (col * n + col)];

        for (int c = 0; c < n; ++c)
        {
            m[(size_t) (col * n + c)] /= d;
            inv[(size_t) (col * n + c)] /= d;
        }

        for (int r = 0; r < n; ++r)
        {
            if (r == col)
                continue;

            const auto factor = m[(size_t) (r * n + col)];

            if (factor == 0.0f)
                continue;

            for (int c = 0; c < n; ++c)
            {
                m[(size_t) (r * n + c)] -= factor * m[(size_t) (col * n + c)];
                inv[(size_t) (r * n + c)] -= factor * inv[(size_t) (col * n + c)];
            }
        }
    }

    m.swap (inv);
    return true;
}
}

//==============================================================================
struct SpectralDenoiser::Channel
{
    /* The sliding analysis window, and how much of it is filled. */
    std::vector<float> inputWindow;
    int windowFill = 0;

    /* Working buffer for the FFT: JUCE's real-only transform wants 2 * fftSize. */
    std::vector<float> frame;

    /* Per-bin state that has to survive between frames. */
    std::vector<float> noiseEstimate;
    std::vector<float> smoothedPower;
    std::vector<float> minimumPower;
    std::vector<float> previousPower;
    std::vector<float> previousGain;
    std::vector<float> previousPowerOut;

    /* Scratch for the across-frequency floor: swept once up the spectrum and once down,
       then combined, which approximates a local minimum without sorting anything. */
    std::vector<float> binPower;
    std::vector<float> floorUp;
    std::vector<float> floorDown;
    std::vector<float> protection;

    /* What the bank is asked for, and where it has actually got to. */
    std::vector<float> bandTargetDb;    // the curve we want, at each centre
    std::vector<float> bandSolvedDb;    // what each filter must be set to to get it
    std::vector<float> bandCurrentDb;   // slewed, and what the filters are set to now

    std::vector<Biquad> bank;

    /** Frames since reset, so the noise floor is seeded from the first frame rather
        than starting at zero and treating the first second as pure signal. */
    int framesSeen = 0;
};

//==============================================================================
SpectralDenoiser::SpectralDenoiser() = default;
SpectralDenoiser::~SpectralDenoiser() = default;

void SpectralDenoiser::buildBands()
{
    bandHz.clear();

    const auto ceilingHz = (float) (hostRate * 0.45);
    auto hz = lowestBandHz;

    while (hz < ceilingHz && (int) bandHz.size() < maxBands)
    {
        bandHz.push_back (hz);
        hz *= std::pow (2.0f, 1.0f / bandsPerOctave);
    }

    numBands = (int) bandHz.size();
}

void SpectralDenoiser::buildInteractionMatrix()
{
    /*  Column j is what filter j does across all the centres when it is set to 1 dB.
        Because a cascade multiplies magnitudes, decibels add, so the cascade's response
        at centre i is the sum over j of (setting_j * column_j[i]) -- a matrix product.
        Inverting it answers the question we actually have, which is the other way
        round: given the curve we want, what does each filter need to be set to?      */
    std::vector<float> m ((size_t) (numBands * numBands), 0.0f);

    for (int j = 0; j < numBands; ++j)
    {
        Biquad probe;
        configureBand (probe, hostRate, bandHz, j, 1.0f);

        for (int i = 0; i < numBands; ++i)
            m[(size_t) (i * numBands + j)] = probe.responseDb (hostRate, bandHz[(size_t) i]);
    }

    if (! invertInPlace (m, numBands))
    {
        /*  Should not happen with sane spacing, but a singular map would otherwise mean
            solving with rubbish. Fall back to treating the filters as independent, which
            over-suppresses where they overlap but is stable and still recognisably does
            the right thing.                                                            */
        m.assign ((size_t) (numBands * numBands), 0.0f);

        for (int i = 0; i < numBands; ++i)
            m[(size_t) (i * numBands + i)] = 1.0f;
    }

    interactionInverse.swap (m);
}

void SpectralDenoiser::prepare (double sampleRate, int maximumBlockSize, int numChannels)
{
    hostRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    maxBlock = juce::jmax (1, maximumBlockSize);

    fft = std::make_unique<juce::dsp::FFT> (fftOrder);

    /*  Analysis only. Nothing is glued back together, so this is a plain Hann and there
        is no overlap-add constant to get right -- which is one entire class of bug that
        this design does not have. */
    window.resize ((size_t) fftSize);

    for (int i = 0; i < fftSize; ++i)
        window[(size_t) i] = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi
                                                     * (float) i / (float) fftSize);

    buildBands();
    buildInteractionMatrix();

    channels.clear();

    for (int ch = 0; ch < juce::jmax (1, numChannels); ++ch)
    {
        auto channel = std::make_unique<Channel>();

        channel->inputWindow.assign ((size_t) fftSize, 0.0f);
        channel->frame.assign ((size_t) (fftSize * 2), 0.0f);

        channel->noiseEstimate.assign ((size_t) numBins, 0.0f);
        channel->smoothedPower.assign ((size_t) numBins, 0.0f);
        channel->minimumPower.assign ((size_t) numBins, 0.0f);
        channel->previousPower.assign ((size_t) numBins, 0.0f);
        channel->previousGain.assign ((size_t) numBins, 1.0f);
        channel->previousPowerOut.assign ((size_t) numBins, 0.0f);
        channel->binPower.assign ((size_t) numBins, 0.0f);
        channel->floorUp.assign ((size_t) numBins, 0.0f);
        channel->floorDown.assign ((size_t) numBins, 0.0f);
        channel->protection.assign ((size_t) numBins, 0.0f);

        channel->bandTargetDb.assign ((size_t) numBands, 0.0f);
        channel->bandSolvedDb.assign ((size_t) numBands, 0.0f);
        channel->bandCurrentDb.assign ((size_t) numBands, 0.0f);
        channel->bank.assign ((size_t) numBands, Biquad());

        channels.push_back (std::move (channel));
    }

    reset();
}

void SpectralDenoiser::reset()
{
    for (auto& c : channels)
    {
        std::fill (c->inputWindow.begin(), c->inputWindow.end(), 0.0f);
        std::fill (c->frame.begin(), c->frame.end(), 0.0f);

        std::fill (c->noiseEstimate.begin(), c->noiseEstimate.end(), 0.0f);
        std::fill (c->smoothedPower.begin(), c->smoothedPower.end(), 0.0f);
        std::fill (c->minimumPower.begin(), c->minimumPower.end(), 0.0f);
        std::fill (c->previousPower.begin(), c->previousPower.end(), 0.0f);
        std::fill (c->previousGain.begin(), c->previousGain.end(), 1.0f);
        std::fill (c->previousPowerOut.begin(), c->previousPowerOut.end(), 0.0f);

        std::fill (c->bandTargetDb.begin(), c->bandTargetDb.end(), 0.0f);
        std::fill (c->bandSolvedDb.begin(), c->bandSolvedDb.end(), 0.0f);
        std::fill (c->bandCurrentDb.begin(), c->bandCurrentDb.end(), 0.0f);

        for (int j = 0; j < numBands; ++j)
        {
            configureBand (c->bank[(size_t) j], hostRate, bandHz, j, 0.0f);
            c->bank[(size_t) j].clearState();
        }

        c->windowFill = 0;
        c->framesSeen = 0;
    }
}

//==============================================================================
void SpectralDenoiser::process (juce::AudioBuffer<float>& buffer, float wetAmount)
{
    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = juce::jmin (buffer.getNumChannels(), (int) channels.size());
    const auto depth = juce::jlimit (0.0f, 1.0f, wetAmount);

    if (numSamples <= 0 || numChannels <= 0 || fft == nullptr || numBands <= 0)
        return;

    const auto slew = juce::jlimit (0.0f, 1.0f,
                                    (float) (numSamples / (bandSlewSeconds * hostRate)));

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& c = *channels[(size_t) ch];
        auto* data = buffer.getWritePointer (ch);

        for (int n = 0; n < numSamples; ++n)
        {
            //---------------------------------------------- listen (off to the side)
            c.inputWindow[(size_t) c.windowFill] = data[n];
            ++c.windowFill;

            if (c.windowFill >= fftSize)
            {
                auto* f = c.frame.data();

                for (int i = 0; i < fftSize; ++i)
                    f[i] = c.inputWindow[(size_t) i] * window[(size_t) i];

                std::fill (f + fftSize, f + fftSize * 2, 0.0f);
                fft->performFrequencyOnlyForwardTransform (f);

                ++c.framesSeen;

                //---- pass one: per-band statistics over time ----
                for (int k = 0; k < numBins; ++k)
                {
                    // performFrequencyOnlyForwardTransform leaves magnitudes in place.
                    const auto magnitude = f[k];
                    const auto power = magnitude * magnitude;
                    c.binPower[(size_t) k] = power;

                    auto& smoothed = c.smoothedPower[(size_t) k];
                    smoothed = powerSmoothing * smoothed + (1.0f - powerSmoothing) * power;

                    auto& minimum = c.minimumPower[(size_t) k];

                    if (c.framesSeen <= 1)
                    {
                        minimum = smoothed;
                        c.noiseEstimate[(size_t) k] = smoothed;
                    }
                    else if (minimum < smoothed)
                    {
                        /*  Creep up slowly, drop instantly. That asymmetry is the whole
                            trick: noise sets the floor and signal never does, because
                            signal is the thing that does not come back down.          */
                        minimum = minimumDecay * minimum
                                + ((1.0f - minimumDecay) / (1.0f - minimumLook))
                                  * (smoothed - minimumLook * c.previousPower[(size_t) k]);
                    }
                    else
                    {
                        minimum = smoothed;
                    }

                    c.previousPower[(size_t) k] = smoothed;

                    // Close to its own minimum: noise, so follow it. Well above: signal,
                    // so leave the estimate where it is.
                    if (smoothed < speechThreshold * juce::jmax (minimum, tiny))
                    {
                        auto& noise = c.noiseEstimate[(size_t) k];
                        noise = noiseFollow * noise + (1.0f - noiseFollow) * smoothed;
                    }
                }

                /*  ---- pass two: the floor of the spectrum, across frequency ----

                    Two sweeps of a tracker that drops to whatever it meets and may only
                    climb by floorRisePerBin, one from each end.

                    The two are then combined with max, not min, and that choice is the
                    whole discrimination. A note is a peak: the spectrum falls away on
                    *both* sides, so both sweeps arrive low and the higher of them is
                    still low. A sloped stretch of broad noise falls away on one side
                    only -- the sweep coming down the slope sits right on top of the
                    signal, so the higher of the two is high and nothing is protected.

                    Taking min instead asks "is anything near me quieter", which on any
                    tilted spectrum is always true. That version protected the whole
                    lower half of a hiss spectrum from being touched.                   */
                {
                    auto up = c.smoothedPower[0];

                    for (int k = 0; k < numBins; ++k)
                    {
                        up = juce::jmin (c.smoothedPower[(size_t) k], up * floorRisePerBin);
                        c.floorUp[(size_t) k] = up;
                    }

                    auto down = c.smoothedPower[(size_t) (numBins - 1)];

                    for (int k = numBins - 1; k >= 0; --k)
                    {
                        down = juce::jmin (c.smoothedPower[(size_t) k], down * floorRisePerBin);
                        c.floorDown[(size_t) k] = down;
                    }
                }

                //---- how tonal is each band, spread over the mainlobe ----
                {
                    for (int k = 0; k < numBins; ++k)
                    {
                        const auto neighbourhood = juce::jmax (
                            juce::jmax (c.floorUp[(size_t) k], c.floorDown[(size_t) k]), tiny);

                        c.protection[(size_t) k] = ramp (c.smoothedPower[(size_t) k] / neighbourhood,
                                                         tonalLow, tonalHigh);
                    }

                    auto up = 0.0f;

                    for (int k = 0; k < numBins; ++k)
                    {
                        up = juce::jmax (c.protection[(size_t) k], up - protectSpreadPerBin);
                        c.protection[(size_t) k] = up;
                    }

                    auto down = 0.0f;

                    for (int k = numBins - 1; k >= 0; --k)
                    {
                        down = juce::jmax (c.protection[(size_t) k], down - protectSpreadPerBin);
                        c.protection[(size_t) k] = down;
                    }
                }

                //---- pass three: a gain per bin, then a curve for the bank ----
                std::fill (c.bandTargetDb.begin(), c.bandTargetDb.end(), 0.0f);

                {
                    std::array<float, (size_t) maxBands> weight {};
                    const auto binHz = (float) (hostRate / fftSize);

                    for (int k = 1; k < numBins; ++k)
                    {
                        const auto power = c.binPower[(size_t) k];
                        const auto noise = juce::jmax (c.noiseEstimate[(size_t) k], tiny);

                        const auto posterior = power / noise;

                        const auto lastGain = c.previousGain[(size_t) k];
                        const auto lastPower = c.previousPowerOut[(size_t) k];

                        const auto prior = juce::jmax (
                            snrSmoothing * (lastGain * lastGain * lastPower / noise)
                            + (1.0f - snrSmoothing) * juce::jmax (posterior - 1.0f, 0.0f),
                            minimumPrior);

                        auto gain = juce::jlimit (0.0f, 1.0f, prior / (1.0f + prior));

                        /*  A band standing clear of its neighbours is a tone, and a tone
                            is somebody's note. Pull the gain back towards unity in
                            proportion to how far it stands out. */
                        gain += (1.0f - gain) * c.protection[(size_t) k];

                        c.previousGain[(size_t) k] = gain;
                        c.previousPowerOut[(size_t) k] = power;

                        /*  Fold the per-bin answer into the band the bin belongs to.
                            Weighted by the bin's own level, because what matters is
                            what happens to the energy that is actually there -- an
                            empty bin should not get an equal vote in how hard a band
                            with a voice in it is pushed down.                        */
                        /*  Clamped, not skipped. The shelves at the ends are responsible
                            for everything beyond the outermost centres, so the bins out
                            there have to get a vote in what those shelves are set to --
                            otherwise the widest part of the spectrum is decided by
                            nobody. */
                        const auto hz = binHz * (float) k;

                        const auto position = juce::jlimit (
                            0.0f, (float) (numBands - 1),
                            std::log (juce::jmax (hz, 1.0f) / bandHz.front())
                                / std::log (2.0f) * bandsPerOctave);

                        const auto lower = juce::jlimit (0, numBands - 1, (int) position);
                        const auto upper = juce::jmin (numBands - 1, lower + 1);
                        const auto blend = juce::jlimit (0.0f, 1.0f, position - (float) lower);

                        const auto gainDb = juce::jmax (juce::Decibels::gainToDecibels (gain),
                                                        maxReductionDb);
                        const auto w = juce::jmax (power, tiny);

                        c.bandTargetDb[(size_t) lower] += gainDb * w * (1.0f - blend);
                        weight[(size_t) lower] += w * (1.0f - blend);

                        c.bandTargetDb[(size_t) upper] += gainDb * w * blend;
                        weight[(size_t) upper] += w * blend;
                    }

                    for (int j = 0; j < numBands; ++j)
                        c.bandTargetDb[(size_t) j] = weight[(size_t) j] > 0.0f
                            ? c.bandTargetDb[(size_t) j] / weight[(size_t) j]
                            : 0.0f;
                }

                //---- what to set each filter to, given they all leak into each other ----
                for (int i = 0; i < numBands; ++i)
                {
                    auto sum = 0.0f;

                    for (int j = 0; j < numBands; ++j)
                        sum += interactionInverse[(size_t) (i * numBands + j)]
                             * c.bandTargetDb[(size_t) j];

                    c.bandSolvedDb[(size_t) i] = juce::jlimit (solvedFloorDb, solvedCeilingDb, sum);
                }

                std::copy (c.inputWindow.begin() + hopSize, c.inputWindow.end(),
                           c.inputWindow.begin());
                c.windowFill = fftSize - hopSize;
            }

            //---------------------------------------------------- act (straight through)
            auto sample = data[n];

            for (int j = 0; j < numBands; ++j)
                sample = c.bank[(size_t) j].processSample (sample);

            data[n] = sample;
        }

        /*  Coefficients are refreshed once a block rather than once a sample: the target
            is already smoothed over 50 ms, so a block's worth of step is far below what
            is audible, and recomputing twenty biquads per sample would cost more than
            everything else here put together.                                         */
        for (int j = 0; j < numBands; ++j)
        {
            auto& current = c.bandCurrentDb[(size_t) j];
            current += (c.bandSolvedDb[(size_t) j] * depth - current) * slew;

            configureBand (c.bank[(size_t) j], hostRate, bandHz, j, current);
        }
    }
}
