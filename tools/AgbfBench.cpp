/*  Additional Gain Before Feedback.

    The figure every anti-feedback unit is sold on: how much more gain the system takes
    before it howls, with the processing in circuit versus without. It is measured, not
    inferred, by binary-searching the critical loop gain under each condition and taking
    the difference.

    The development harness answers "did I break it". This answers "what may we claim",
    which is a different and stricter question -- so it runs many randomised rooms and
    reports the distribution rather than one flattering configuration.

    Build:  cmake --preset vs -DLOSTDUCK_BUILD_HARNESS=ON
            cmake --build --preset vs --config Release --target LostDuckAgbfBench
*/

#include "LoopSim.h"
#include "../source/FeedbackGuard.h"
#include "../source/SpectralDenoiser.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

namespace
{
constexpr double sampleRate = 48000.0;
constexpr int blockSize = 256;

constexpr float settleSeconds = 1.2f;   // analyser warm-up is ~0.8 s
constexpr float testSeconds = 4.5f;
constexpr float measureSeconds = 0.5f;  // window at the end that decides stability

/** How far above the dry-voice level counts as "the loop has taken over". */
constexpr float instabilityMarginDb = 10.0f;

constexpr int numRooms = 20;
constexpr int searchIterations = 9;     // 40 dB range -> better than 0.1 dB
constexpr float searchLowDb = -20.0f;
constexpr float searchHighDb = 20.0f;

/** What a live vocal channel is actually sitting in: mains hum with a couple of odd
    harmonics, preamp hiss tilted towards the top, and low rumble off the stage. Each
    part can be asked for on its own so the table says which one the denoiser is good
    at rather than averaging them into one uninformative number. */
class StageNoise
{
public:
    struct Spec
    {
        const char* name = "noise";
        float hum = 0.0f;       // 50 Hz plus 150 and 250
        float hiss = 0.0f;      // high-tilted white
        float rumble = 0.0f;    // low-passed white
    };

    StageNoise (const Spec& s, int seed = 7777) : spec (s), random (seed) {}

    void prepare (double sr) { sampleRate = sr; }

    float next()
    {
        phase += juce::MathConstants<float>::twoPi * 50.0f / static_cast<float> (sampleRate);

        if (phase > juce::MathConstants<float>::twoPi)
            phase -= juce::MathConstants<float>::twoPi;

        auto out = spec.hum * (std::sin (phase)
                               + 0.35f * std::sin (phase * 3.0f)
                               + 0.18f * std::sin (phase * 5.0f));

        const auto white = random.nextFloat() * 2.0f - 1.0f;

        // One-pole each way off the same white source.
        low += 0.02f * (white - low);
        high = 0.85f * (high + white - lastWhite);
        lastWhite = white;

        out += spec.hiss * high * 0.5f;
        out += spec.rumble * low * 6.0f;

        return out;
    }

private:
    Spec spec;
    juce::Random random;
    double sampleRate = 48000.0;
    float phase = 0.0f;
    float low = 0.0f, high = 0.0f, lastWhite = 0.0f;
};

struct EngineConfig
{
    bool active = true;
    float shiftHz = 5.0f;
    int maxFilters = 16;

    /** Noise knob position. Above zero the denoiser runs inside the loop, latency and
        all, which is the only way its effect on stability means anything. */
    float denoise = 0.0f;
};

/** Runs the loop at one fixed gain and reports whether it stayed under control. */
struct RunResult
{
    float finalDb = -120.0f;
    float peakDb = -120.0f;
    int notches = 0;
    float secondsToRecover = -1.0f;   // -1 when it never ran away, or never recovered
};

RunResult runLoop (const std::vector<sim::Mode>& modes, int delaySamples, float gainDb,
                   const EngineConfig& config, float referenceDb, bool trackRecovery)
{
    sim::Room room;
    room.prepare (sampleRate, delaySamples, blockSize, modes);

    sim::VoiceSource voice;
    voice.prepare (sampleRate);

    fg::FeedbackGuardEngine engine;
    engine.prepare (sampleRate, blockSize);
    engine.setSensitivity (fg::Sensitivity::medium);
    engine.setMaxFilters (config.maxFilters);
    engine.setShiftHz (config.shiftHz);

    SpectralDenoiser denoiser;

    if (config.denoise > 0.0f)
        denoiser.prepare (sampleRate, blockSize, 2);

    const auto gain = juce::Decibels::decibelsToGain (gainDb);
    const auto totalBlocks = static_cast<int> ((settleSeconds + testSeconds) * sampleRate / blockSize);
    const auto measureFrom = static_cast<int> ((settleSeconds + testSeconds - measureSeconds) * sampleRate / blockSize);
    const auto onsetThreshold = referenceDb + 6.0f;
    const auto recoveredThreshold = referenceDb + 3.0f;

    juce::AudioBuffer<float> block (2, blockSize);

    RunResult result;
    double measureSum = 0.0;
    int measureCount = 0;
    float onsetTime = -1.0f;
    float recoveredFor = 0.0f;

    for (int b = 0; b < totalBlocks; ++b)
    {
        double blockSum = 0.0;

        for (int i = 0; i < blockSize; ++i)
        {
            const auto mic = voice.next() + room.readArrival (gain);
            block.setSample (0, i, mic);
            block.setSample (1, i, mic);
            blockSum += static_cast<double> (mic) * mic;
        }

        if (config.active)
            engine.process (block);

        // Inside the loop, exactly where it sits in the plug-in, so its latency affects
        // which frequencies come back in phase rather than being assumed harmless.
        if (config.denoise > 0.0f)
            denoiser.process (block, config.denoise);

        for (int i = 0; i < blockSize; ++i)
            room.push (block.getSample (0, i));

        const auto blockDb = sim::dbOf (static_cast<float> (std::sqrt (blockSum / blockSize)));
        result.peakDb = juce::jmax (result.peakDb, blockDb);

        if (b >= measureFrom)
        {
            measureSum += blockSum;
            measureCount += blockSize;
        }

        if (trackRecovery)
        {
            const auto now = static_cast<float> (b * blockSize / sampleRate);
            const auto blockSeconds = static_cast<float> (blockSize / sampleRate);

            if (onsetTime < 0.0f && now > settleSeconds && blockDb > onsetThreshold)
                onsetTime = now;

            if (onsetTime >= 0.0f && result.secondsToRecover < 0.0f)
            {
                if (blockDb < recoveredThreshold)
                {
                    recoveredFor += blockSeconds;

                    // Has to hold, not just dip through on the way past.
                    if (recoveredFor > 0.20f)
                        result.secondsToRecover = now - recoveredFor - onsetTime;
                }
                else
                {
                    recoveredFor = 0.0f;
                }
            }
        }
    }

    result.finalDb = measureCount > 0
                   ? sim::dbOf (static_cast<float> (std::sqrt (measureSum / measureCount)))
                   : -120.0f;
    result.notches = engine.getSnapshot().activeFilters.load();
    return result;
}

/** Highest gain, in dB, at which the loop is still under control after testSeconds. */
float findCriticalGainDb (const std::vector<sim::Mode>& modes, int delaySamples,
                          const EngineConfig& config, float referenceDb)
{
    auto low = searchLowDb;    // assumed stable
    auto high = searchHighDb;  // assumed unstable

    for (int i = 0; i < searchIterations; ++i)
    {
        const auto mid = 0.5f * (low + high);
        const auto r = runLoop (modes, delaySamples, mid, config, referenceDb, false);
        const auto stable = r.finalDb < referenceDb + instabilityMarginDb;

        if (stable)
            low = mid;
        else
            high = mid;
    }

    return low;
}

struct RecoveryResult
{
    float milliseconds = -1.0f;   // -1 when it never came back
    float excursionDb = 0.0f;     // how far above the settled level it got
    int notches = 0;
};

/** Holds a stable gain, then steps it past the passive limit and times the return.
    Recovery is judged against the level the system had settled at before the step, not
    against dry voice: at high gain a perfectly stable loop still sits several dB up,
    and measuring against dry would report a healthy system as never recovering. */
RecoveryResult measureRecovery (const std::vector<sim::Mode>& modes, int delaySamples,
                                float startGainDb, float stepGainDb)
{
    sim::Room room;
    room.prepare (sampleRate, delaySamples, blockSize, modes);

    sim::VoiceSource voice;
    voice.prepare (sampleRate);

    fg::FeedbackGuardEngine engine;
    engine.prepare (sampleRate, blockSize);
    engine.setSensitivity (fg::Sensitivity::medium);
    engine.setMaxFilters (16);
    engine.setShiftHz (5.0f);

    constexpr float beforeSeconds = 2.5f;
    constexpr float afterSeconds = 6.0f;
    const auto blockSeconds = static_cast<float> (blockSize / sampleRate);
    const auto stepBlock = static_cast<int> (beforeSeconds * sampleRate / blockSize);
    const auto totalBlocks = static_cast<int> ((beforeSeconds + afterSeconds) * sampleRate / blockSize);

    juce::AudioBuffer<float> block (2, blockSize);

    RecoveryResult result;
    double baselineSum = 0.0;
    int baselineCount = 0;
    float baselineDb = -120.0f;
    float onsetTime = -1.0f;
    float settledFor = 0.0f;

    for (int b = 0; b < totalBlocks; ++b)
    {
        const auto gain = juce::Decibels::decibelsToGain (b < stepBlock ? startGainDb : stepGainDb);
        double blockSum = 0.0;

        for (int i = 0; i < blockSize; ++i)
        {
            const auto mic = voice.next() + room.readArrival (gain);
            block.setSample (0, i, mic);
            block.setSample (1, i, mic);
            blockSum += static_cast<double> (mic) * mic;
        }

        engine.process (block);

        for (int i = 0; i < blockSize; ++i)
            room.push (block.getSample (0, i));

        const auto blockDb = sim::dbOf (static_cast<float> (std::sqrt (blockSum / blockSize)));
        const auto now = static_cast<float> (b * blockSize / sampleRate);

        // Settle the baseline over the half second before the step.
        if (b < stepBlock && now > beforeSeconds - 0.5f)
        {
            baselineSum += blockSum;
            baselineCount += blockSize;
        }

        if (b == stepBlock && baselineCount > 0)
            baselineDb = sim::dbOf (static_cast<float> (std::sqrt (baselineSum / baselineCount)));

        if (b < stepBlock || baselineDb < -119.0f)
            continue;

        result.excursionDb = juce::jmax (result.excursionDb, blockDb - baselineDb);

        if (onsetTime < 0.0f && blockDb > baselineDb + 6.0f)
            onsetTime = now;

        if (onsetTime >= 0.0f && result.milliseconds < 0.0f)
        {
            if (blockDb < baselineDb + 3.0f)
            {
                settledFor += blockSeconds;

                // Has to hold, not just dip through on the way past.
                if (settledFor > 0.20f)
                    result.milliseconds = (now - settledFor - onsetTime) * 1000.0f;
            }
            else
            {
                settledFor = 0.0f;
            }
        }
    }

    result.notches = engine.getSnapshot().activeFilters.load();
    return result;
}

float median (std::vector<float> v)
{
    if (v.empty()) return 0.0f;
    std::sort (v.begin(), v.end());
    return v[v.size() / 2];
}

/** `lowerIsBetter` matters: for AGBF the smallest number is the worst case, for reaction
    time it is the best. Labelling those the same way round would quietly flatter one of
    them every time the table is read. */
void summarise (const char* label, std::vector<float> v, const char* unit, bool lowerIsBetter = false)
{
    if (v.empty()) { std::printf ("   %-26s no data\n", label); return; }

    std::sort (v.begin(), v.end());

    const auto best = lowerIsBetter ? v.front() : v.back();
    const auto worst = lowerIsBetter ? v.back() : v.front();

    std::printf ("   %-26s median %7.1f %-3s   worst %7.1f   best %7.1f\n",
                 label, median (v), unit, worst, best);
}
}

//==============================================================================
int main()
{
    std::printf ("LOST Duck -- Additional Gain Before Feedback\n");
    std::printf ("%.0f Hz, %d-sample blocks, %d randomised rooms\n\n", sampleRate, blockSize, numRooms);

    // Dry reference: the microphone level with no feedback path at all.
    float referenceDb = -120.0f;
    {
        sim::VoiceSource voice;
        voice.prepare (sampleRate);
        double sum = 0.0;
        const auto n = static_cast<int> (sampleRate * 2.0);

        for (int i = 0; i < n; ++i)
        {
            const auto v = voice.next();
            sum += static_cast<double> (v) * v;
        }

        referenceDb = sim::dbOf (static_cast<float> (std::sqrt (sum / n)));
    }

    std::printf ("dry voice reference: %.1f dBFS RMS\n", referenceDb);
    std::printf ("a room counts as unstable once the mic sits %.0f dB above that\n\n", instabilityMarginDb);

    juce::Random random (20260808);

    std::vector<float> agbf, bypassedCritical, activeCritical, recoverMs;
    int neverRecovered = 0;

    std::printf ("  room  modes  delay      bypassed    active     AGBF   notches\n");
    std::printf ("  ----------------------------------------------------------------\n");

    for (int r = 0; r < numRooms; ++r)
    {
        const auto numModes = 8 + random.nextInt (13);          // 8..20
        const auto modes = sim::makeRandomRoom (random, numModes);
        const auto delay = blockSize + random.nextInt (1280);   // >= one block, up to ~32 m

        const auto bypassed = findCriticalGainDb (modes, delay, { false, 0.0f, 0 }, referenceDb);
        const auto active = findCriticalGainDb (modes, delay, { true, 5.0f, 16 }, referenceDb);
        const auto gain = active - bypassed;

        bypassedCritical.push_back (bypassed);
        activeCritical.push_back (active);
        agbf.push_back (gain);

        // Recovery, measured the way it happens in a room: run comfortably stable, then
        // shove the gain well past the passive limit, as somebody pushing a fader does,
        // and time how long the level takes to come back to where it was.
        const auto probe = measureRecovery (modes, delay, bypassed - 6.0f, bypassed + 4.0f);

        if (probe.milliseconds >= 0.0f)
            recoverMs.push_back (probe.milliseconds);
        else if (probe.excursionDb > 6.0f)
            ++neverRecovered;

        std::printf ("   %3d    %3d   %5d   %8.1f  %8.1f  %7.1f   %3d\n",
                     r + 1, numModes, delay, bypassed, active, gain, probe.notches);
    }

    std::printf ("\n== headline ==\n");
    summarise ("AGBF", agbf, "dB");
    summarise ("critical gain, bypassed", bypassedCritical, "dB");
    summarise ("critical gain, active", activeCritical, "dB");

    if (! recoverMs.empty())
        summarise ("time to suppress", recoverMs, "ms", true);

    std::printf ("   %-26s %d of %d rooms\n", "never recovered", neverRecovered, numRooms);

    //==========================================================================
    std::printf ("\n== transparency, no feedback path ==\n");

    // Deliberately awkward. The old corpus was four dense harmonic voices, which is the
    // easy case, and it passed while the plug-in notched real instruments.
    const sim::ToneSource::Spec programs[] = {
        { "voice 196 Hz",        196.0f,  7, 2.0f, 24.0f, 0.22f },
        { "voice 110 Hz",        110.0f,  7, 2.0f, 24.0f, 0.22f },
        { "pure sine 1 kHz",    1000.0f,  1, 2.0f,  0.0f, 0.30f },
        { "flute-ish 880 Hz",    880.0f,  2, 2.6f,  8.0f, 0.28f },
        { "synth lead 2 kHz",   2000.0f,  2, 2.2f,  0.0f, 0.30f },
        { "bass 41 Hz",           41.0f,  9, 1.4f,  0.0f, 0.30f },
        { "organ 220 Hz",        220.0f, 10, 1.0f,  0.0f, 0.24f },
        { "plucked 330 Hz",      330.0f,  5, 1.6f,  0.0f, 0.26f },
    };

    int worstNotches = 0;
    float worstChange = 0.0f;

    for (const auto& spec : programs)
    {
        fg::FeedbackGuardEngine engine;
        engine.prepare (sampleRate, blockSize);
        engine.setSensitivity (fg::Sensitivity::medium);
        engine.setMaxFilters (16);
        engine.setShiftHz (5.0f);

        sim::ToneSource tone (spec, 4242);
        tone.prepare (sampleRate);

        juce::AudioBuffer<float> block (2, blockSize);
        double inSum = 0.0, outSum = 0.0;
        std::vector<float> dry ((size_t) blockSize);

        const auto blocks = static_cast<int> (12.0 * sampleRate / blockSize);

        for (int b = 0; b < blocks; ++b)
        {
            for (int i = 0; i < blockSize; ++i)
            {
                const auto v = tone.next();
                dry[(size_t) i] = v;
                block.setSample (0, i, v);
                block.setSample (1, i, v);
            }

            engine.process (block);

            for (int i = 0; i < blockSize; ++i)
            {
                inSum += static_cast<double> (dry[(size_t) i]) * dry[(size_t) i];
                outSum += static_cast<double> (block.getSample (0, i)) * block.getSample (0, i);
            }
        }

        const auto change = juce::Decibels::gainToDecibels (
            static_cast<float> (std::sqrt (outSum / juce::jmax (1.0, inSum))));
        const auto notches = engine.getSnapshot().activeFilters.load();

        worstNotches = juce::jmax (worstNotches, notches);
        worstChange = juce::jmin (worstChange, change);

        std::printf ("   %-20s  %+6.2f dB   %d notches%s\n",
                     spec.name, change, notches, notches > 0 ? "   <-- FALSE POSITIVE" : "");
    }

    std::printf ("\n   worst case: %+.2f dB, %d notches on programme material\n",
                 worstChange, worstNotches);

    // The case that was reported from a real vocal: notches landing at 8.7, 9.3 and
    // 9.8 kHz, and one at 151 Hz on the fundamental.
    {
        fg::FeedbackGuardEngine engine;
        engine.prepare (sampleRate, blockSize);
        engine.setSensitivity (fg::Sensitivity::medium);
        engine.setMaxFilters (16);
        engine.setShiftHz (5.0f);

        sim::SingingSource singer;
        singer.prepare (sampleRate);

        juce::AudioBuffer<float> block (2, blockSize);
        double inSum = 0.0, outSum = 0.0;
        std::vector<float> dry ((size_t) blockSize);

        const auto blocks = static_cast<int> (25.0 * sampleRate / blockSize);
        float peakShift = 0.0f;

        for (int b = 0; b < blocks; ++b)
        {
            for (int i = 0; i < blockSize; ++i)
            {
                const auto v = singer.next();
                dry[(size_t) i] = v;
                block.setSample (0, i, v);
                block.setSample (1, i, v);
            }

            engine.process (block);
            peakShift = juce::jmax (peakShift, engine.getSnapshot().activeShiftHz.load());

            for (int i = 0; i < blockSize; ++i)
            {
                inSum += static_cast<double> (dry[(size_t) i]) * dry[(size_t) i];
                outSum += static_cast<double> (block.getSample (0, i)) * block.getSample (0, i);
            }
        }

        const auto change = juce::Decibels::gainToDecibels (
            static_cast<float> (std::sqrt (outSum / juce::jmax (1.0, inSum))));
        const auto placed = engine.getSnapshot().activeFilters.load();

        std::printf ("\n   singing with consonants, 25 s:  %+.2f dB   %d notches%s\n",
                     change, placed, placed > 0 ? "   <-- notching the singer" : "");

        // The measurement that matters for voice quality, and the one an RMS figure
        // cannot see: a shifter leaves level untouched while making the harmonics
        // inharmonic. If it never engaged, it never touched the voice.
        std::printf ("   shifter engaged during singing: peak %.2f Hz  %s\n",
                     peakShift,
                     peakShift < 0.05f ? "never -- voice untouched" : "<-- ENGAGED ON CLEAN VOICE");

        for (size_t i = 0; i < fg::maxFilterSlots; ++i)
            if (const auto hz = engine.getSnapshot().filterHz[i].load(); hz > 0.0f)
                std::printf ("      %6.0f Hz\n", hz);
    }

    //==========================================================================
    std::printf ("\n== spectral denoiser ==\n");

    {
        /*  Two questions, and a denoiser is only good if both answers are good.

            "What does it cost the wanted signal" on its own can be aced by doing
            nothing. "How much noise does it remove" on its own can be aced by muting.
            RNNoise scored well on the second and catastrophically on the first -- it
            took a steady tone down 100 dB because the tone was not speech. So both
            tables are printed, and neither is allowed to be read alone. */
        std::printf ("   what it costs each source, per knob position (dB -- nearer 0 is better):\n\n");
        std::printf ("   %-20s %8s %8s %8s %8s\n", "", "25%", "50%", "75%", "100%");

        for (const auto& spec : programs)
        {
            std::printf ("   %-20s", spec.name);

            for (const float amount : { 0.25f, 0.5f, 0.75f, 1.0f })
            {
                SpectralDenoiser denoiser;
                denoiser.prepare (sampleRate, blockSize, 2);

                sim::ToneSource tone (spec, 4242);
                tone.prepare (sampleRate);

                juce::AudioBuffer<float> block (2, blockSize);
                double inSum = 0.0, outSum = 0.0;
                std::vector<float> dry ((size_t) blockSize);

                const auto blocks = static_cast<int> (8.0 * sampleRate / blockSize);

                for (int b = 0; b < blocks; ++b)
                {
                    for (int i = 0; i < blockSize; ++i)
                    {
                        const auto v = tone.next();
                        dry[(size_t) i] = v;
                        block.setSample (0, i, v);
                        block.setSample (1, i, v);
                    }

                    denoiser.process (block, amount);

                    // Skip the first second: the frame buffer and the dry delay have to
                    // fill before input and output are comparable at all.
                    if (b < static_cast<int> (sampleRate / blockSize))
                        continue;

                    for (int i = 0; i < blockSize; ++i)
                    {
                        inSum += static_cast<double> (dry[(size_t) i]) * dry[(size_t) i];
                        outSum += static_cast<double> (block.getSample (0, i)) * block.getSample (0, i);
                    }
                }

                const auto change = juce::Decibels::gainToDecibels (
                    static_cast<float> (std::sqrt (outSum / juce::jmax (1.0e-12, inSum))));

                std::printf (" %8.2f", change);
            }

            std::printf ("\n");
        }

        //----------------------------------------------------------------------
        const StageNoise::Spec noises[] = {
            { "mains hum",       0.030f, 0.000f, 0.000f },
            { "preamp hiss",     0.000f, 0.030f, 0.000f },
            { "stage rumble",    0.000f, 0.000f, 0.030f },
            { "all three",       0.018f, 0.018f, 0.018f },
        };

        std::printf ("\n   what it removes from noise alone (dB -- more negative is better):\n\n");
        std::printf ("   %-20s %8s %8s %8s %8s\n", "", "25%", "50%", "75%", "100%");

        for (const auto& spec : noises)
        {
            std::printf ("   %-20s", spec.name);

            for (const float amount : { 0.25f, 0.5f, 0.75f, 1.0f })
            {
                SpectralDenoiser denoiser;
                denoiser.prepare (sampleRate, blockSize, 2);

                StageNoise noise (spec, 4242);
                noise.prepare (sampleRate);

                juce::AudioBuffer<float> block (2, blockSize);
                double inSum = 0.0, outSum = 0.0;

                const auto blocks = static_cast<int> (8.0 * sampleRate / blockSize);

                for (int b = 0; b < blocks; ++b)
                {
                    for (int i = 0; i < blockSize; ++i)
                    {
                        const auto v = noise.next();
                        block.setSample (0, i, v);
                        block.setSample (1, i, v);

                        if (b >= static_cast<int> (sampleRate / blockSize))
                            inSum += static_cast<double> (v) * v;
                    }

                    denoiser.process (block, amount);

                    if (b < static_cast<int> (sampleRate / blockSize))
                        continue;

                    for (int i = 0; i < blockSize; ++i)
                        outSum += static_cast<double> (block.getSample (0, i)) * block.getSample (0, i);
                }

                std::printf (" %8.2f", juce::Decibels::gainToDecibels (
                    static_cast<float> (std::sqrt (outSum / juce::jmax (1.0e-12, inSum)))));
            }

            std::printf ("\n");
        }

        //----------------------------------------------------------------------
        /*  The one that decides whether it is worth switching on.

            An earlier version of this measured the voice and the noise on separate
            passes and subtracted. That was worthless: a noise suppressor fed nothing
            but voice has nothing else to call noise, so it learns the voice as the
            floor and the number says the voice was destroyed. It has to see a real
            mixture.

            So: one pass, voice gated on and off over a constant noise bed, and the two
            stretches measured separately. What happens during the gaps is the noise
            reduction; what happens while the voice is present is the cost of it. Both
            come from the same run, on the same signal, with the denoiser in exactly the
            state it would be in on a stage. */
        std::printf ("\n   sung voice over a constant noise bed, one pass (dB):\n\n");
        std::printf ("   %-20s %8s %8s %8s %8s\n", "", "25%", "50%", "75%", "100%");

        constexpr float voiceOnSeconds = 1.0f;
        constexpr float voiceOffSeconds = 0.6f;
        constexpr float settleSecondsAfterEdge = 0.15f;

        float gapRow[4] {}, voiceRow[4] {};
        int column = 0;

        for (const float amount : { 0.25f, 0.5f, 0.75f, 1.0f })
        {
            SpectralDenoiser denoiser;
            denoiser.prepare (sampleRate, blockSize, 2);

            sim::SingingSource singing (99);
            singing.prepare (sampleRate);

            StageNoise noise ({ "bed", 0.012f, 0.020f, 0.008f }, 4242);
            noise.prepare (sampleRate);

            juce::AudioBuffer<float> block (2, blockSize);

            double gapIn = 0.0, gapOut = 0.0, voiceIn = 0.0, voiceOut = 0.0;
            int gapCount = 0, voiceCount = 0;

            std::vector<float> dry ((size_t) blockSize);
            std::vector<char> counts ((size_t) blockSize);

            const auto totalBlocks = static_cast<int> (14.0 * sampleRate / blockSize);
            const auto warmup = static_cast<int> (2.0 * sampleRate / blockSize);

            float cyclePos = 0.0f;
            bool voiceActive = true;

            for (int b = 0; b < totalBlocks; ++b)
            {
                for (int i = 0; i < blockSize; ++i)
                {
                    cyclePos += 1.0f / static_cast<float> (sampleRate);

                    if (cyclePos > (voiceActive ? voiceOnSeconds : voiceOffSeconds))
                    {
                        cyclePos = 0.0f;
                        voiceActive = ! voiceActive;
                    }

                    // The voice runs continuously and is gated on the way in, so the
                    // phrases are the same ones in every column.
                    const auto v = singing.next();
                    const auto fed = noise.next() + (voiceActive ? v : 0.0f);

                    dry[(size_t) i] = fed;
                    block.setSample (0, i, fed);
                    block.setSample (1, i, fed);

                    // Settled samples only: right after an edge the denoiser is still
                    // reacting, and neither number means anything there.
                    counts[(size_t) i] = cyclePos > settleSecondsAfterEdge
                                       ? (voiceActive ? 1 : 2) : 0;
                }

                denoiser.process (block, amount);

                if (b < warmup)
                    continue;

                for (int i = 0; i < blockSize; ++i)
                {
                    const auto in = static_cast<double> (dry[(size_t) i]) * dry[(size_t) i];
                    const auto o = static_cast<double> (block.getSample (0, i)) * block.getSample (0, i);

                    if (counts[(size_t) i] == 1) { voiceIn += in; voiceOut += o; ++voiceCount; }
                    else if (counts[(size_t) i] == 2) { gapIn += in; gapOut += o; ++gapCount; }
                }
            }

            const auto ratio = [] (double num, double den)
            {
                return juce::Decibels::gainToDecibels (
                    static_cast<float> (std::sqrt (num / juce::jmax (1.0e-12, den))));
            };

            jassert (gapCount > 0 && voiceCount > 0);
            juce::ignoreUnused (gapCount, voiceCount);

            gapRow[column] = ratio (gapOut, gapIn);
            voiceRow[column] = ratio (voiceOut, voiceIn);
            ++column;
        }

        std::printf ("   %-20s", "noise in the gaps");
        for (const auto v : gapRow) std::printf (" %8.2f", v);
        std::printf ("      <- want this low\n");

        std::printf ("   %-20s", "while singing");
        for (const auto v : voiceRow) std::printf (" %8.2f", v);
        std::printf ("      <- want this near 0\n");

        std::printf ("   %-20s", "SNR gained");
        for (int i = 0; i < 4; ++i) std::printf (" %8.2f", voiceRow[i] - gapRow[i]);
        std::printf ("      <- want this high\n");

        SpectralDenoiser probe;
        probe.prepare (sampleRate, blockSize, 2);
        std::printf ("\n   reported latency: %d samples (%.1f ms at %.0f Hz)\n",
                     probe.getLatencySamples(),
                     1000.0 * probe.getLatencySamples() / sampleRate, sampleRate);

        /*  What it costs to run, because the complaint that started all of this was the
            noise control loading the CPU. Reported as a fraction of real time on one
            core: 0.01 means a second of audio takes ten milliseconds to process. */
        {
            juce::AudioBuffer<float> block (2, blockSize);
            sim::SingingSource singing (99);
            singing.prepare (sampleRate);

            const auto seconds = 20.0;
            const auto blocks = static_cast<int> (seconds * sampleRate / blockSize);

            for (int i = 0; i < blockSize; ++i)
            {
                const auto v = singing.next();
                block.setSample (0, i, v);
                block.setSample (1, i, v);
            }

            const auto started = juce::Time::getHighResolutionTicks();

            for (int b = 0; b < blocks; ++b)
                probe.process (block, 1.0f);

            const auto elapsed = juce::Time::highResolutionTicksToSeconds (
                juce::Time::getHighResolutionTicks() - started);

            std::printf ("   cost to run:      %.2f%% of one core, stereo at %.0f Hz\n",
                         100.0 * elapsed / seconds, sampleRate);
        }

        // The interaction that matters: that latency sits inside the acoustic loop, so
        // it changes which frequencies come back in phase. Same rooms, same seeds, only
        // the denoiser differs -- so any change in AGBF is attributable to it.
        std::printf ("\n   AGBF with the denoiser in circuit, same 8 rooms both ways:\n");

        std::vector<float> without, with;

        for (int r = 0; r < 8; ++r)
        {
            juce::Random rr (20260808 + r * 7919);
            const auto numModes = 8 + rr.nextInt (13);
            const auto modes = sim::makeRandomRoom (rr, numModes);
            const auto delay = blockSize + rr.nextInt (1280);

            const auto bypassed = findCriticalGainDb (modes, delay, { false, 0.0f, 0, 0.0f }, referenceDb);
            const auto dry = findCriticalGainDb (modes, delay, { true, 5.0f, 16, 0.0f }, referenceDb);
            const auto wet = findCriticalGainDb (modes, delay, { true, 5.0f, 16, 1.0f }, referenceDb);

            without.push_back (dry - bypassed);
            with.push_back (wet - bypassed);
        }

        summarise ("AGBF, denoiser off", without, "dB");
        summarise ("AGBF, denoiser 100%", with, "dB");
    }

    //==========================================================================
    // The limit has to be obeyed exactly, including when it is lowered mid-session:
    // filters already placed past the new ceiling must retire, not keep running.
    std::printf ("\n== notch limit is obeyed ==\n");

    {
        juce::Random rr (4242);
        const auto modes = sim::makeRandomRoom (rr, 18);
        const auto delay = blockSize + 700;

        std::printf ("   %-24s %8s %8s\n", "", "used", "verdict");

        for (const int limit : { 1, 2, 3, 5, 8, 16 })
        {
            const auto r = runLoop (modes, delay, 6.0f, { true, 5.0f, limit, 0.0f }, referenceDb, false);
            const auto ok = r.notches <= limit;

            std::printf ("   limit %-18d %8d %8s\n", limit, r.notches, ok ? "ok" : "OVER");
        }

        // Now the case that was broken: run wide open, then clamp down hard.
        sim::Room room;
        room.prepare (sampleRate, delay, blockSize, modes);
        sim::VoiceSource voice;
        voice.prepare (sampleRate);

        fg::FeedbackGuardEngine engine;
        engine.prepare (sampleRate, blockSize);
        engine.setSensitivity (fg::Sensitivity::medium);
        engine.setShiftHz (5.0f);
        engine.setMaxFilters (16);

        juce::AudioBuffer<float> block (2, blockSize);
        const auto gain = juce::Decibels::decibelsToGain (6.0f);
        const auto blocks = static_cast<int> (10.0 * sampleRate / blockSize);
        const auto clampAt = blocks / 2;
        int peakBeforeClamp = 0;

        for (int b = 0; b < blocks; ++b)
        {
            if (b == clampAt)
                engine.setMaxFilters (2);

            for (int i = 0; i < blockSize; ++i)
            {
                const auto mic = voice.next() + room.readArrival (gain);
                block.setSample (0, i, mic);
                block.setSample (1, i, mic);
            }

            engine.process (block);

            for (int i = 0; i < blockSize; ++i)
                room.push (block.getSample (0, i));

            if (b < clampAt)
                peakBeforeClamp = juce::jmax (peakBeforeClamp, engine.getSnapshot().activeFilters.load());
        }

        const auto after = engine.getSnapshot().activeFilters.load();
        std::printf ("\n   16 then clamped to 2:  %d used before, %d after   %s\n",
                     peakBeforeClamp, after, after <= 2 ? "ok" : "OVER");
    }

    std::printf ("\ndone\n");
    return 0;
}
