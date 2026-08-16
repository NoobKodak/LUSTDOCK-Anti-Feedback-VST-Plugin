#include "FeedbackGuard.h"

#include <cmath>

namespace fg
{
namespace
{
/** Anything below this is silence as far as detection is concerned, whatever its
    prominence -- otherwise the noise floor of a muted channel grows peaks. */
constexpr float absoluteFloorDb = -78.0f;

/** How close two frequencies have to be to count as the same one. */
constexpr float sameFrequencyFraction = 0.015f;

/** A candidate that stops appearing for this long is abandoned. */
constexpr float candidateForgetSeconds = 0.40f;

float dbOf (float magnitude) noexcept
{
    return juce::Decibels::gainToDecibels (juce::jmax (magnitude, 1.0e-9f));
}

/** One-pole step for a given time constant, safe for any block length. */
float stepToward (float current, float target, float seconds, float timeConstant) noexcept
{
    const auto alpha = juce::jlimit (0.0f, 1.0f, seconds / juce::jmax (1.0e-4f, timeConstant));
    return current + (target - current) * alpha;
}
}

//==============================================================================
Tuning Tuning::forSensitivity (Sensitivity sensitivity)
{
    Tuning t;

    switch (sensitivity)
    {
        case Sensitivity::low:
            t.prominenceDb = 12.0f;
            t.growthDb = 4.0f;
            t.confirmSeconds = 0.45f;
            t.confirmHits = 12;
            t.startDepthDb = -10.0f;
            t.maxDepthDb = -36.0f;
            break;

        case Sensitivity::high:
            t.prominenceDb = 7.0f;
            t.growthDb = 1.5f;
            t.confirmSeconds = 0.18f;
            t.confirmHits = 5;
            t.startDepthDb = -14.0f;
            t.maxDepthDb = -48.0f;
            break;

        case Sensitivity::medium:
        default:
            break;
    }

    return t;
}

//==============================================================================
void NotchFilter::prepare (double sampleRate)
{
    sr = sampleRate;
    clear();
}

void NotchFilter::reset()
{
    z1.fill (0.0f);
    z2.fill (0.0f);
}

void NotchFilter::clear()
{
    used = false;
    locked = false;
    releasing = false;
    id = 0;
    depthDb = 0.0f;
    targetDepthDb = 0.0f;
    fade = 0.0f;
    targetFade = 0.0f;
    secondsSinceSeen = 0.0f;
    reset();
}

void NotchFilter::assign (float newFrequency, float newDepthDb, float newQ, int newId)
{
    frequency = juce::jlimit (60.0f, 18000.0f, newFrequency);
    targetFrequency = frequency;
    depthDb = 0.0f;
    targetDepthDb = newDepthDb;
    qValue = newQ;
    fade = 0.0f;
    targetFade = 1.0f;
    secondsSinceSeen = 0.0f;
    id = newId;
    used = true;
    locked = false;
    releasing = false;
    reset();
    updateCoefficients();
}

void NotchFilter::deepen (float newDepthDb)
{
    // Frequency is intentionally untouched -- see the note in the header.
    targetDepthDb = newDepthDb;
    targetFade = 1.0f;
    releasing = false;
    secondsSinceSeen = 0.0f;
}

void NotchFilter::release()
{
    if (locked)
        return;

    releasing = true;
    targetFade = 0.0f;
}

bool NotchFilter::isNear (float hz, float fraction) const noexcept
{
    return used && std::abs (frequency - hz) <= juce::jmax (frequency, hz) * fraction;
}

void NotchFilter::updateForBlock (float blockSeconds)
{
    if (! used)
        return;

    secondsSinceSeen += blockSeconds;

    frequency = stepToward (frequency, targetFrequency, blockSeconds, 0.020f);
    depthDb = stepToward (depthDb, targetDepthDb, blockSeconds, 0.060f);
    fade = stepToward (fade, targetFade, blockSeconds, 0.015f);

    if (releasing && fade < 0.002f)
    {
        clear();
        return;
    }

    updateCoefficients();
}

void NotchFilter::processBlock (juce::AudioBuffer<float>& buffer, int numChannels)
{
    if (! used || fade <= 0.0001f)
        return;

    const auto numSamples = buffer.getNumSamples();

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* data = buffer.getWritePointer (ch);
        auto& s1 = z1[(size_t) ch];
        auto& s2 = z2[(size_t) ch];

        for (int i = 0; i < numSamples; ++i)
        {
            const auto dry = data[i];
            const auto wet = b0 * dry + s1;

            s1 = b1 * dry - a1 * wet + s2;
            s2 = b2 * dry - a2 * wet;

            data[i] = dry + (wet - dry) * fade;
        }
    }
}

void NotchFilter::updateCoefficients()
{
    // Standard peaking-EQ biquad driven to a cut. The depth is applied in full here;
    // `fade` does the blending, so it must not also scale the gain or the two compound
    // and the notch never reaches the depth it was asked for.
    const auto a = std::pow (10.0f, depthDb / 40.0f);
    const auto omega = juce::MathConstants<float>::twoPi * frequency / static_cast<float> (sr);
    const auto alpha = std::sin (omega) / (2.0f * qValue);
    const auto cosw = std::cos (omega);
    const auto norm = 1.0f / (1.0f + alpha / a);

    b0 = (1.0f + alpha * a) * norm;
    b1 = -2.0f * cosw * norm;
    b2 = (1.0f - alpha * a) * norm;
    a1 = -2.0f * cosw * norm;
    a2 = (1.0f - alpha / a) * norm;
}

//==============================================================================
void NotchBank::prepare (double sampleRate)
{
    sr = sampleRate;

    for (auto& f : filters)
        f.prepare (sampleRate);

    nextId = 1;
}

void NotchBank::reset()
{
    for (auto& f : filters)
        f.clear();

    nextId = 1;
}

int NotchBank::findNear (float hz, int maxFilters) const noexcept
{
    // Wider than the tracker's own tolerance on purpose. Two notches 3% apart do the
    // job of one and waste a slot, so anything inside a notch's own skirt merges.
    constexpr float mergeFraction = 0.045f;

    // Bounded by the limit: a filter sitting past it is on its way out, and matching it
    // here would retune and revive it, undoing the retirement.
    const auto limit = juce::jlimit (0, maxFilterSlots, maxFilters);

    for (int i = 0; i < limit; ++i)
        if (filters[(size_t) i].isNear (hz, mergeFraction))
            return i;

    return -1;
}

int NotchBank::findFreeSlot (int maxFilters) const noexcept
{
    const auto limit = juce::jlimit (0, maxFilterSlots, maxFilters);

    for (int i = 0; i < limit; ++i)
        if (! filters[(size_t) i].isUsed())
            return i;

    return -1;
}

int NotchBank::findWeakestUnlocked (int maxFilters) const noexcept
{
    const auto limit = juce::jlimit (0, maxFilterSlots, maxFilters);

    int best = -1;
    float bestScore = -1.0f;

    for (int i = 0; i < limit; ++i)
    {
        const auto& f = filters[(size_t) i];

        if (! f.isUsed() || f.isLocked())
            continue;

        // Shallowest, and least recently useful, goes first.
        const auto score = f.getSecondsSinceSeen() - f.getDepthDb() * 0.1f;

        if (score > bestScore)
        {
            bestScore = score;
            best = i;
        }
    }

    return best;
}

void NotchBank::applyDetection (float hz, const Tuning& tuning, int maxFilters)
{
    if (const auto existing = findNear (hz, maxFilters); existing >= 0)
    {
        auto& f = filters[(size_t) existing];

        // Still there after being notched, so lean on it harder -- but only down to the
        // configured limit, and never on a locked filter the operator set by hand.
        const auto deepened = f.isLocked()
                            ? f.getDepthDb()
                            : juce::jmax (tuning.maxDepthDb, f.getDepthDb() + tuning.deepenStepDb);

        f.deepen (deepened);
        f.markSeen();
        return;
    }

    auto slot = findFreeSlot (maxFilters);

    if (slot < 0)
        slot = findWeakestUnlocked (maxFilters);

    if (slot < 0)
        return;

    filters[(size_t) slot].assign (hz, tuning.startDepthDb, tuning.q, nextId++);
}

int NotchBank::getActiveFrequencies (float* out, int maxOut) const
{
    int count = 0;

    for (const auto& f : filters)
    {
        if (count >= maxOut)
            break;

        if (f.isUsed())
            out[count++] = f.getFrequency();
    }

    return count;
}

void NotchBank::reinforce (float hz, const Tuning& tuning, int maxFilters)
{
    const auto existing = findNear (hz, maxFilters);

    if (existing < 0)
        return;

    auto& f = filters[(size_t) existing];

    const auto deepened = f.isLocked()
                        ? f.getDepthDb()
                        : juce::jmax (tuning.maxDepthDb, f.getDepthDb() + tuning.deepenStepDb);

    f.deepen (deepened);
    f.markSeen();
}

void NotchBank::ageAndProcess (juce::AudioBuffer<float>& buffer, const Tuning& tuning, int maxFilters)
{
    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = juce::jmin (2, buffer.getNumChannels());
    const auto blockSeconds = static_cast<float> (numSamples / sr);
    const auto limit = juce::jlimit (0, maxFilterSlots, maxFilters);

    for (int i = 0; i < maxFilterSlots; ++i)
    {
        auto& f = filters[(size_t) i];

        // Anything past the current limit is retired, however it got there. Turning the
        // dial down has to take effect on what is already placed, not just on what gets
        // placed next -- otherwise choosing 2 leaves four filters running.
        if (i >= limit && f.isUsed())
            f.release();

        if (f.isUsed() && ! f.isLocked() && f.getSecondsSinceSeen() > tuning.releaseSeconds)
            f.release();

        f.updateForBlock (blockSeconds);
        f.processBlock (buffer, numChannels);
    }
}

void NotchBank::clearUnlocked()
{
    for (auto& f : filters)
        if (f.isUsed() && ! f.isLocked())
            f.release();
}

void NotchBank::lockAll()
{
    for (auto& f : filters)
        f.lock();
}

int NotchBank::activeCount() const noexcept
{
    int n = 0;

    for (const auto& f : filters)
        if (f.isUsed())
            ++n;

    return n;
}

float NotchBank::deepestDepthDb() const noexcept
{
    float deepest = 0.0f;

    for (const auto& f : filters)
        if (f.isUsed())
            deepest = juce::jmin (deepest, f.getDepthDb());

    return deepest;
}

void NotchBank::readInto (EngineSnapshot& snapshot) const
{
    for (size_t i = 0; i < filters.size(); ++i)
        snapshot.filterHz[i].store (filters[i].isUsed() ? filters[i].getFrequency() : 0.0f,
                                    std::memory_order_relaxed);

    snapshot.activeFilters.store (activeCount(), std::memory_order_relaxed);
    snapshot.deepestDepthDb.store (deepestDepthDb(), std::memory_order_relaxed);
}

//==============================================================================
void SpectralAnalyzer::prepare (double newSampleRate)
{
    sampleRate = newSampleRate;
    binHz = static_cast<float> (sampleRate / fftSize);

    // 150 Hz to 8 kHz. Narrower than it was, and deliberately so for a live vocal:
    //
    //   - above 8 kHz you get sibilance, not howl. Air is absorbed, microphone and
    //     speaker responses roll off, and sustained oscillation up there is rare. What
    //     the detector was finding at 8.7, 9.3 and 9.8 kHz was consonants.
    //   - below 150 Hz you get vocal fundamentals, stage rumble and handling noise, and
    //     feedback that low is usually a gain-structure problem a high-pass filter
    //     should have dealt with.
    minBin = juce::jlimit (3, numBins - 6, static_cast<int> (150.0f / binHz));
    maxBin = juce::jlimit (minBin + 8, numBins - 4, static_cast<int> (8000.0f / binHz));

    // Analysed wider than that, purely so the harmonic tests have somewhere to look.
    analysisMinBin = juce::jlimit (2, minBin, static_cast<int> (40.0f / binHz));
    analysisMaxBin = juce::jlimit (maxBin, numBins - 3, static_cast<int> (19000.0f / binHz));

    reset();
}

void SpectralAnalyzer::reset()
{
    fifo.fill (0.0f);
    fftData.fill (0.0f);
    fastDb.fill (absoluteFloorDb);
    slowDb.fill (absoluteFloorDb);
    verySlowDb.fill (absoluteFloorDb);
    floorDb.fill (absoluteFloorDb);
    fifoIndex = 0;
    sinceLastFrame = 0;
    primed = false;
    framesSinceReset = 0;
    samplesSeen = 0;
    meanGrowthDb = 0.0f;
    meanCreepDb = 0.0f;
}

bool SpectralAnalyzer::pushSample (float mono, Frame& frame, const Tuning& tuning)
{
    fifo[(size_t) fifoIndex] = mono;
    fifoIndex = (fifoIndex + 1) & (fftSize - 1);
    ++samplesSeen;

    if (++sinceLastFrame < hopSize)
        return false;

    sinceLastFrame = 0;

    // Nothing is analysed until the window holds real audio all the way through.
    if (samplesSeen < fftSize)
        return false;
    analyse (frame, tuning);
    return true;
}

float SpectralAnalyzer::prominenceNear (float hz) const
{
    const auto centre = static_cast<int> (std::lround (hz / binHz));
    float best = 0.0f;

    // Bounded by the analysis band, not the detection band: a 60 Hz bass fundamental
    // sits below where feedback is looked for, and a 2 kHz lead's fourth harmonic sits
    // above it. Clamping to the detection band made both invisible, so every partial
    // looked like an isolated tone.
    for (int b = centre - 2; b <= centre + 2; ++b)
    {
        if (b <= analysisMinBin || b >= analysisMaxBin)
            continue;

        best = juce::jmax (best, fastDb[(size_t) b] - floorDb[(size_t) b]);
    }

    return best;
}

bool SpectralAnalyzer::sitsOnHarmonicSeries (float hz, float ownProminence) const
{
    // Is this peak itself the root of a series? A sung fundamental drags its overtones
    // along with it; feedback is an isolated partial.
    {
        int overtones = 0;

        for (int m = 2; m <= 8; ++m)
            if (prominenceNear (hz * static_cast<float> (m)) > 6.0f)
                ++overtones;

        // Two is enough. Requiring three missed sparse spectra -- a flute-like synth or
        // a plucked string may only put two measurable partials in the band, and those
        // were exactly the sources being notched.
        if (overtones >= 2)
            return true;
    }

    // Otherwise try to explain it as the d'th harmonic of something lower. Checking
    // only f/2 and f/3 is not enough: a 196 Hz voice puts narrow, prominent partials at
    // 980 Hz and 1372 Hz that look exactly like feedback on their own.
    for (int d = 2; d <= 8; ++d)
    {
        const auto fundamental = hz / static_cast<float> (d);

        // Down to 45 Hz, not 75: a bass guitar's low E is 41 Hz and its harmonics were
        // being treated as isolated tones because the search gave up before reaching it.
        if (fundamental < 45.0f)
            break;

        const auto fundamentalProminence = prominenceNear (fundamental);

        if (fundamentalProminence < 8.0f)
            continue;

        // One coincidence is not a series. Require several members before believing it.
        //
        // Counting from m = 1 so the fundamental counts as a member of its own series.
        // It used to start at 2, which quietly made this test unsatisfiable for any
        // source with exactly two partials: the only member it could ever find was the
        // peak being explained, giving members = 1 against a threshold of 2. A flute at
        // 880 Hz with a single overtone 15 dB down therefore had its 1758 Hz harmonic
        // notched -- the fundamental was right there, strong and obvious, and the count
        // refused to look at it.
        int members = 0;

        // Two partials, matching the threshold the branch above already uses for the
        // same reason -- a sparse spectrum is still a spectrum.
        for (int m = 1; m <= 8; ++m)
            if (prominenceNear (fundamental * static_cast<float> (m)) > 6.0f)
                ++members;

        if (members < 2)
            continue;

        // A harmonic is weaker than the fundamental it belongs to. If this peak towers
        // over the series it sits in, it is feedback that happens to land near a
        // partial rather than the partial itself, and it must still be notched. The
        // margin is deliberately tight: room modes do land on harmonics sometimes, and
        // waiting for a 6 dB excess before believing it costs real reaction time.
        //
        // Scaled by how much series there actually is. Two members is the least
        // evidence that still counts as a series, so it takes correspondingly less to
        // overrule -- letting a sparse series claim a peak on the same 4 dB as a dense
        // one pushed worst-case suppression from 261 ms to 1520 ms, because genuine
        // feedback kept being written off as somebody's second harmonic.
        const auto towerMargin = members >= 3 ? 4.0f : 0.0f;

        if (ownProminence <= fundamentalProminence + towerMargin)
            return true;
    }

    return false;
}

void SpectralAnalyzer::analyse (Frame& frame, const Tuning& tuning)
{
    frame.count = 0;

    for (int i = 0; i < fftSize; ++i)
        fftData[(size_t) i] = fifo[(size_t) ((fifoIndex + i) & (fftSize - 1))];

    window.multiplyWithWindowingTable (fftData.data(), fftSize);
    std::fill (fftData.begin() + fftSize, fftData.end(), 0.0f);
    fft.performFrequencyOnlyForwardTransform (fftData.data(), true);

    // A Hann-windowed full-scale sine puts about fftSize/4 in its peak bin, so this
    // normalisation makes 0 dB mean "full-scale tone" and keeps the thresholds
    // independent of FFT size.
    constexpr float coherentGain = 0.25f;
    const auto scale = 1.0f / (static_cast<float> (fftSize) * coherentGain);

    double growthSum = 0.0;
    double creepSum = 0.0;
    int counted = 0;

    for (int bin = analysisMinBin; bin <= analysisMaxBin && bin < numBins; ++bin)
    {
        if (bin < 0)
            continue;

        const auto db = dbOf (fftData[(size_t) bin] * scale);

        if (! primed)
        {
            fastDb[(size_t) bin] = db;
            slowDb[(size_t) bin] = db;
            verySlowDb[(size_t) bin] = db;
            continue;
        }

        fastDb[(size_t) bin] = fastDb[(size_t) bin] * 0.62f + db * 0.38f;
        slowDb[(size_t) bin] = slowDb[(size_t) bin] * 0.97f + db * 0.03f;
        verySlowDb[(size_t) bin] = verySlowDb[(size_t) bin] * 0.997f + db * 0.003f;

        growthSum += fastDb[(size_t) bin] - slowDb[(size_t) bin];
        creepSum += fastDb[(size_t) bin] - verySlowDb[(size_t) bin];
        ++counted;
    }

    meanGrowthDb = counted > 0 ? static_cast<float> (growthSum / counted) : 0.0f;
    meanCreepDb = counted > 0 ? static_cast<float> (creepSum / counted) : 0.0f;

    primed = true;

    // Roughly 0.8 s at a 512 hop. Long enough for the slow average to mean something.
    constexpr int warmupFrames = 75;

    if (++framesSinceReset < warmupFrames)
        return;

    // Local floor: a wide symmetric smear of the spectrum, done as a forward then
    // backward one-pole so it costs two passes instead of a windowed average per bin.
    // Computed over the analysis band, not the detection band, so the harmonic tests
    // can measure prominence outside where feedback is looked for.
    constexpr float floorAlpha = 0.10f;
    float running = fastDb[(size_t) analysisMinBin];

    for (int bin = analysisMinBin; bin <= analysisMaxBin; ++bin)
    {
        running += (fastDb[(size_t) bin] - running) * floorAlpha;
        floorDb[(size_t) bin] = running;
    }

    running = fastDb[(size_t) analysisMaxBin];

    for (int bin = analysisMaxBin; bin >= analysisMinBin; --bin)
    {
        running += (fastDb[(size_t) bin] - running) * floorAlpha;
        floorDb[(size_t) bin] = juce::jmin (floorDb[(size_t) bin], running);
    }


    for (int bin = minBin + 6; bin <= maxBin - 6; ++bin)
    {
        const auto level = fastDb[(size_t) bin];

        if (level < absoluteFloorDb)
            continue;

        // Must be the local maximum, and must fall away sharply on both sides: feedback
        // is one or two bins wide, programme material is not.
        if (level < fastDb[(size_t) (bin - 1)] || level < fastDb[(size_t) (bin + 1)])
            continue;

        // Measured six bins out, not three. Feedback is one or two bins wide, so it has
        // collapsed long before here. Sibilance spreads energy over whole kilohertz and
        // still looks narrow across a 70 Hz window, which is how "s" and "t" were
        // getting notched.
        const auto shoulder = juce::jmax (fastDb[(size_t) (bin - 6)], fastDb[(size_t) (bin + 6)]);

        if (level - shoulder < 8.0f)
            continue;

        const auto prominence = level - floorDb[(size_t) bin];

        if (prominence < tuning.prominenceDb)
            continue;

        // Parabolic interpolation across the peak and its neighbours. Bin 8 is 187.5 Hz
        // where the real partial is at 196, and multiplying that error by 7 lands two
        // and a half bins from the harmonic being looked for -- which is enough to miss
        // it entirely. It also puts the notch on the tone rather than beside it.
        const auto below = fastDb[(size_t) (bin - 1)];
        const auto above = fastDb[(size_t) (bin + 1)];
        const auto curvature = below - 2.0f * level + above;
        const auto offset = std::abs (curvature) > 1.0e-6f
                          ? juce::jlimit (-0.5f, 0.5f, 0.5f * (below - above) / curvature)
                          : 0.0f;

        const auto refinedHz = (static_cast<float> (bin) + offset) * binHz;

        if (sitsOnHarmonicSeries (refinedHz, prominence))
            continue;

        // Feedback builds. A held note does not, however loud or narrow it is.
        //
        // There used to be an escape hatch here: anything standing 19 dB above the
        // floor skipped this test, on the theory that only feedback gets that
        // prominent. That was wrong, and it is what made the plug-in notch instruments
        // -- a synth lead or an organ note sits 20 to 40 dB above its local floor all
        // day. Growth is now required unconditionally.
        //
        // Two windows: fast-minus-slow catches a howl coming up in a few hundred
        // milliseconds, fast-minus-veryslow catches somebody creeping a fader up over
        // several seconds. A sustained note shows neither.
        // Measured against how much the rest of the spectrum moved, not against zero.
        // A note attack, a crescendo, or somebody raising the master fader lifts every
        // bin together, so the excess over the mean is small. Feedback is one partial
        // running away while everything else sits still, so its excess is large. An
        // absolute test cannot tell those apart, and vetoing frames where lots of bins
        // rose threw away the real howls too -- a loop going unstable lifts every mode
        // at once.
        const auto growth = level - slowDb[(size_t) bin] - meanGrowthDb;
        const auto creep = level - verySlowDb[(size_t) bin] - meanCreepDb;

        if (growth < tuning.growthDb && creep < tuning.growthDb)
            continue;

        Peak peak;
        peak.frequency = refinedHz;
        peak.prominenceDb = prominence;
        peak.growthDb = growth;

        // Prominence says "this is a tone"; growth says "and it is running away", which
        // is what separates feedback from a held note. Growth only ever adds.
        peak.score = juce::jlimit (0.0f, 1.0f, (prominence - tuning.prominenceDb) / 18.0f)
                   + juce::jlimit (0.0f, 0.5f, peak.growthDb / 12.0f);

        // Keep the frame's best few, ordered by score.
        int position = frame.count;

        while (position > 0 && frame.peaks[(size_t) (position - 1)].score < peak.score)
        {
            if (position < maxCandidates)
                frame.peaks[(size_t) position] = frame.peaks[(size_t) (position - 1)];

            --position;
        }

        if (position < maxCandidates)
            frame.peaks[(size_t) position] = peak;

        frame.count = juce::jmin (maxCandidates, frame.count + 1);
    }
}

//==============================================================================
void CandidateTracker::prepare (double)
{
    reset();
}

void CandidateTracker::reset()
{
    for (auto& c : candidates)
        c = {};

    bestHz = 0.0f;
    bestConfidence = 0.0f;
}

int CandidateTracker::update (const SpectralAnalyzer::Frame& frame, float frameSeconds,
                              const Tuning& tuning, float* confirmed, int maxConfirmed)
{
    for (auto& c : candidates)
    {
        if (! c.used)
            continue;

        c.ageSeconds += frameSeconds;
        c.sinceSeenSeconds += frameSeconds;

        if (c.sinceSeenSeconds > candidateForgetSeconds)
            c = {};
    }

    for (int p = 0; p < frame.count; ++p)
    {
        const auto& peak = frame.peaks[(size_t) p];
        int slot = -1;

        for (size_t i = 0; i < candidates.size(); ++i)
        {
            if (! candidates[i].used)
                continue;

            const auto tolerance = juce::jmax (candidates[i].frequency, peak.frequency) * sameFrequencyFraction;

            if (std::abs (candidates[i].frequency - peak.frequency) <= tolerance)
            {
                slot = static_cast<int> (i);
                break;
            }
        }

        if (slot < 0)
        {
            for (size_t i = 0; i < candidates.size(); ++i)
            {
                if (! candidates[i].used)
                {
                    slot = static_cast<int> (i);
                    candidates[i] = {};
                    candidates[i].used = true;
                    candidates[i].frequency = peak.frequency;
                    break;
                }
            }
        }

        if (slot < 0)
            continue;

        auto& c = candidates[(size_t) slot];
        c.frequency = c.frequency * 0.7f + peak.frequency * 0.3f;
        c.sinceSeenSeconds = 0.0f;
        c.scoreSum += peak.score;
        ++c.hits;
    }

    int count = 0;
    bestHz = 0.0f;
    bestConfidence = 0.0f;

    for (auto& c : candidates)
    {
        if (! c.used)
            continue;

        const auto confidence = juce::jlimit (0.0f, 1.0f, c.scoreSum / static_cast<float> (juce::jmax (1, tuning.confirmHits)));

        if (confidence > bestConfidence)
        {
            bestConfidence = confidence;
            bestHz = c.frequency;
        }

        if (c.hits >= tuning.confirmHits && c.ageSeconds >= tuning.confirmSeconds)
        {
            if (count < maxConfirmed)
                confirmed[count++] = c.frequency;

            // Made its case; it has to earn the next one, which paces how fast a notch
            // is allowed to deepen.
            c.hits = 0;
            c.ageSeconds = 0.0f;
            c.scoreSum = 0.0f;
        }
    }

    return count;
}

//==============================================================================
namespace
{
/** Two all-pass chains whose outputs stay 90 degrees apart across the audio band, once
    the first is delayed by one sample. Standard Hilbert-network coefficients; the
    values are squared pole radii and are not worth re-deriving by hand. */
constexpr std::array<float, 4> inPhaseCoefficients {
    0.6923878f, 0.9360654322959f, 0.9882295226860f, 0.9987488452737f };

constexpr std::array<float, 4> quadratureCoefficients {
    0.4021921162426f, 0.8561710882420f, 0.9722909545651f, 0.9952884791278f };
}

void FrequencyShifter::prepare (double sampleRate)
{
    sr = sampleRate;

    for (auto& channel : channels)
    {
        for (size_t i = 0; i < channel.inPhase.size(); ++i)
            channel.inPhase[i].c = inPhaseCoefficients[i];

        for (size_t i = 0; i < channel.quadrature.size(); ++i)
            channel.quadrature[i].c = quadratureCoefficients[i];
    }

    reset();
}

void FrequencyShifter::reset()
{
    for (auto& channel : channels)
        channel.reset();

    phase = 0.0f;
}

void FrequencyShifter::process (juce::AudioBuffer<float>& buffer)
{
    if (shiftHz <= 0.0f)
        return;

    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = juce::jmin ((int) channels.size(), buffer.getNumChannels());
    const auto increment = juce::MathConstants<float>::twoPi * shiftHz / static_cast<float> (sr);

    auto endPhase = phase;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto& channel = channels[(size_t) ch];
        auto* data = buffer.getWritePointer (ch);
        auto localPhase = phase;

        for (int i = 0; i < numSamples; ++i)
        {
            const auto in = data[i];

            auto a = in;
            for (auto& section : channel.inPhase)
                a = section.process (a);

            auto b = in;
            for (auto& section : channel.quadrature)
                b = section.process (b);

            // The pair is only in quadrature once the in-phase branch is held back a
            // sample, which is what makes this single sideband instead of a ring
            // modulator with both sidebands present.
            const auto iPart = channel.delayed;
            const auto qPart = b;
            channel.delayed = a;

            // Plus, not minus: this selects the upper sideband. Either direction breaks
            // the loop equally, but shifting up walks a surviving tone toward the top
            // of the band where the room damps it, where shifting down walks it into
            // the hotter low modes.
            data[i] = iPart * std::cos (localPhase) + qPart * std::sin (localPhase);

            localPhase += increment;

            if (localPhase > juce::MathConstants<float>::twoPi)
                localPhase -= juce::MathConstants<float>::twoPi;
        }

        endPhase = localPhase;
    }

    phase = endPhase;
}

//==============================================================================
void SafetyLimiter::prepare (double sampleRate)
{
    releaseCoeff = std::exp (-1.0f / static_cast<float> (sampleRate * 0.08));
    reset();
}

void SafetyLimiter::reset()
{
    envelope = 0.0f;
}

void SafetyLimiter::process (juce::AudioBuffer<float>& buffer)
{
    constexpr float ceiling = 0.8912509f;   // -1 dBFS

    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = buffer.getNumChannels();

    for (int i = 0; i < numSamples; ++i)
    {
        float peak = 0.0f;

        for (int ch = 0; ch < numChannels; ++ch)
            peak = juce::jmax (peak, std::abs (buffer.getSample (ch, i)));

        envelope = juce::jmax (peak, envelope * releaseCoeff);

        if (envelope <= ceiling)
            continue;

        const auto gain = ceiling / envelope;

        for (int ch = 0; ch < numChannels; ++ch)
            buffer.setSample (ch, i, buffer.getSample (ch, i) * gain);
    }
}

//==============================================================================
void FeedbackGuardEngine::prepare (double sampleRate, int)
{
    sr = sampleRate;
    analyzer.prepare (sampleRate);
    tracker.prepare (sampleRate);
    bank.prepare (sampleRate);
    shifter.prepare (sampleRate);
    limiter.prepare (sampleRate);
    reset();
}

void FeedbackGuardEngine::reset()
{
    analyzer.reset();
    tracker.reset();
    bank.reset();
    shifter.reset();
    limiter.reset();

    // Start at the floor, not at zero. Ramping up to it would sweep every partial
    // across bins on the way, and a sweeping spectrum reads as growth -- which put
    // notches on clean programme material within the first second.
    feedbackRisk = Tuning::forSensitivity (sensitivity).shiftFloor;
    shifter.setShiftHz (shiftCeilingHz * feedbackRisk);

    snapshot.candidateHz.store (0.0f);
    snapshot.confidence.store (0.0f);
    snapshot.activeFilters.store (0);
    snapshot.deepestDepthDb.store (0.0f);
    snapshot.activeShiftHz.store (0.0f);

    for (auto& hz : snapshot.filterHz)
        hz.store (0.0f);
}

void FeedbackGuardEngine::process (juce::AudioBuffer<float>& buffer)
{
    const auto tuning = Tuning::forSensitivity (sensitivity);

    if (clearRequested.exchange (false))
        bank.clearUnlocked();

    if (lockRequested.exchange (false))
        bank.lockAll();

    bank.ageAndProcess (buffer, tuning, maxFilters);

    // Wind the shifter to match the current risk before using it. Attack is quick
    // enough to be in place while a mode is still building; release is slow so it does
    // not chatter on and off through a phrase, which would be worse than leaving it on.
    {
        const auto blockSeconds = static_cast<float> (buffer.getNumSamples() / sr);
        const auto active = bank.activeCount();
        const auto confidence = tracker.strongestConfidence();

        // Engaged on a *candidate*, not on a placed notch. Waiting for a notch means
        // waiting out the whole confirmation window, by which point the loop has
        // already run away and the shifter has missed the moment it was for. A
        // candidate exists as soon as a narrow non-harmonic peak starts growing, which
        // is early enough to matter and still never happens on clean singing.
        // A floor that is always present, rising to the full ceiling when trouble
        // appears. Purely reactive shifting measured 2.0 dB AGBF against 7.5 for
        // always-on: shifting prevents a loop from establishing, and once one has
        // saturated it will not break it, so arriving after detection is arriving too
        // late. The floor keeps the preventative part while costing a fraction of the
        // colouration -- inharmonicity scales with the shift.
        const auto floorRisk = tuning.shiftFloor;

        const auto target = active > 0 ? 1.0f
                          : confidence > 0.12f ? juce::jlimit (floorRisk, 1.0f, confidence * 1.6f)
                          : floorRisk;

        const auto timeConstant = target > feedbackRisk ? 0.15f : 12.0f;
        const auto alpha = juce::jlimit (0.0f, 1.0f, blockSeconds / timeConstant);
        feedbackRisk += (target - feedbackRisk) * alpha;

        // Below a whisker of risk the shifter is switched off outright rather than run
        // at a fraction of a hertz, so a clean vocal passes through untouched.
        const auto wanted = feedbackRisk < 0.02f ? 0.0f : shiftCeilingHz * feedbackRisk;
        shifter.setShiftHz (wanted);
        snapshot.activeShiftHz.store (wanted, std::memory_order_relaxed);
    }

    // After the notches, before the limiter. The few Hz of offset is a fifth of an FFT
    // bin, so the analyser below is unaffected by it.
    shifter.process (buffer);
    limiter.process (buffer);

    // Analyse what actually came out. See the note at the top of the header: this is
    // what lets a working notch retire and a failing one be deepened.
    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = juce::jmax (1, buffer.getNumChannels());
    const auto frameSeconds = static_cast<float> (SpectralAnalyzer::hopSize / sr);
    const auto* left = buffer.getReadPointer (0);
    const auto* right = numChannels > 1 ? buffer.getReadPointer (1) : left;

    std::array<float, maxCandidates> confirmed {};

    for (int i = 0; i < numSamples; ++i)
    {
        if (! analyzer.pushSample (0.5f * (left[i] + right[i]), frame, tuning))
            continue;

        const auto found = tracker.update (frame, frameSeconds, tuning, confirmed.data(), maxCandidates);

        for (int c = 0; c < found; ++c)
            bank.applyDetection (confirmed[(size_t) c], tuning, maxFilters);
    }

    // Notches that are already placed get re-confirmed on prominence alone. A working
    // notch stops its tone rising, so demanding growth here would retire the filter and
    // hand the howl straight back -- which is exactly what it did before this existed.
    {
        std::array<float, maxFilterSlots> active {};
        const auto count = bank.getActiveFrequencies (active.data(), maxFilterSlots);

        for (int i = 0; i < count; ++i)
            if (analyzer.prominenceAt (active[(size_t) i]) > tuning.prominenceDb)
                bank.reinforce (active[(size_t) i], tuning, maxFilters);
    }

    snapshot.candidateHz.store (tracker.strongestHz(), std::memory_order_relaxed);
    snapshot.confidence.store (tracker.strongestConfidence(), std::memory_order_relaxed);
    bank.readInto (snapshot);
}
}
