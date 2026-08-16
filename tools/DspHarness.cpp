/*  Offline measurement harness for the Feedback Guard engine.

    An anti-feedback plug-in cannot be judged by feeding it a sine and checking that a
    filter appeared. What matters is whether it breaks a runaway acoustic loop without
    damaging the programme material, so that is what this measures.

    A loop is simulated: microphone -> plug-in -> PA -> room -> back into microphone.
    The room is three high-Q resonances, and the one-block processing delay stands in
    for the acoustic path (512 samples, 10.7 ms -- a realistic stage distance). Loop
    gain is ramped past unity so it genuinely howls. Three conditions are compared:

      1. bypass       -- nothing in the loop, to confirm the rig really does run away
      2. limiter only -- proves containment is not just the safety limiter clamping
      3. full engine  -- detection plus notches

    Then a clean voice is run through on its own to measure what the engine does when
    there is no feedback to find, which is the false-positive test the original project
    never had.

    Build:  cmake --preset vs -DLOSTDUCK_BUILD_HARNESS=ON
            cmake --build --preset vs --config Release --target LostDuckDspHarness
*/

#include "../source/FeedbackGuard.h"

#include <juce_core/juce_core.h>

#include <cmath>
#include <cstdio>
#include <vector>

namespace
{
constexpr double sampleRate = 48000.0;
constexpr int blockSize = 512;

//==============================================================================
/** One resonant mode of the room. RBJ band-pass, unity gain at resonance, so the loop
    gain multiplier is exactly the round-trip gain at the mode frequencies. */
struct Resonator
{
    void set (float hz, float q)
    {
        const auto omega = juce::MathConstants<float>::twoPi * hz / static_cast<float> (sampleRate);
        const auto alpha = std::sin (omega) / (2.0f * q);
        const auto cosw = std::cos (omega);
        const auto a0 = 1.0f + alpha;

        b0 = alpha / a0;
        b2 = -alpha / a0;
        a1 = -2.0f * cosw / a0;
        a2 = (1.0f - alpha) / a0;
    }

    float process (float x)
    {
        const auto y = b0 * x + z1;
        z1 = -a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }

    float b0 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
};

/** The room: what the PA puts out comes back into the microphone, coloured by three
    narrow modes and scaled by the loop gain. */
class Room
{
public:
    Room()
    {
        // Nine modes at deliberately irregular spacing. Three was not enough to show
        // migration: with only a few, notching them ends the problem. A real room hands
        // you a new one every time you kill the last, which is the failure being
        // reproduced here.
        modes[0].set (312.0f, 34.0f);
        modes[1].set (735.0f, 38.0f);
        modes[2].set (1430.0f, 40.0f);
        modes[3].set (1910.0f, 42.0f);
        modes[4].set (2760.0f, 45.0f);
        modes[5].set (3480.0f, 44.0f);
        modes[6].set (4310.0f, 40.0f);
        modes[7].set (5120.0f, 38.0f);
        modes[8].set (6840.0f, 36.0f);
    }

    float process (float speaker, float loopGain)
    {
        float summed = 0.0f;

        for (auto& mode : modes)
            summed += mode.process (speaker);

        // Real rooms saturate; without this a diverging loop reaches infinity and the
        // numbers stop meaning anything.
        return juce::jlimit (-8.0f, 8.0f, summed * loopGain);
    }

private:
    std::array<Resonator, 9> modes;
};

//==============================================================================
/** A vocal-ish signal: harmonic series, vibrato, a little noise. Deliberately tonal,
    because that is exactly what a naive detector notches by mistake. */
class VoiceSource
{
public:
    float next()
    {
        phase += juce::MathConstants<float>::twoPi * fundamental
               * (1.0f + 0.02f * std::sin (vibratoPhase)) / static_cast<float> (sampleRate);
        vibratoPhase += juce::MathConstants<float>::twoPi * 5.0f / static_cast<float> (sampleRate);

        if (phase > juce::MathConstants<float>::twoPi) phase -= juce::MathConstants<float>::twoPi;
        if (vibratoPhase > juce::MathConstants<float>::twoPi) vibratoPhase -= juce::MathConstants<float>::twoPi;

        float sum = 0.0f;

        for (int h = 1; h <= 7; ++h)
            sum += std::sin (phase * static_cast<float> (h)) / static_cast<float> (h * h);

        return sum * 0.22f + (random.nextFloat() - 0.5f) * 0.002f;
    }

private:
    float fundamental = 196.0f;
    float phase = 0.0f;
    float vibratoPhase = 0.0f;
    juce::Random random { 20260808 };
};

//==============================================================================
enum class Condition { bypass, limiterOnly, fullEngine };

const char* nameOf (Condition c)
{
    switch (c)
    {
        case Condition::bypass:      return "bypass      ";
        case Condition::limiterOnly: return "limiter only";
        case Condition::fullEngine:  return "full engine ";
    }

    return "?";
}

struct LoopResult
{
    float worstMicDb = -120.0f;
    float finalMicDb = -120.0f;
    int filters = 0;
    std::array<float, fg::maxFilterSlots> filterHz {};
};

/** Magnitude at one frequency, by correlating against a complex exponential. Cheaper to
    write than an FFT and exact at the frequency asked for. */
float magnitudeAt (const std::vector<float>& signal, float hz)
{
    double re = 0.0, im = 0.0;
    const auto w = juce::MathConstants<double>::twoPi * hz / sampleRate;

    for (size_t i = 0; i < signal.size(); ++i)
    {
        re += signal[i] * std::cos (w * (double) i);
        im += signal[i] * std::sin (w * (double) i);
    }

    return static_cast<float> (2.0 * std::sqrt (re * re + im * im) / (double) signal.size());
}

LoopResult runLoop (Condition condition, float seconds, bool verbose, int maxFilters, float shiftHz)
{
    Room room;
    VoiceSource voice;

    fg::FeedbackGuardEngine engine;
    fg::SafetyLimiter limiter;
    engine.prepare (sampleRate, blockSize);
    engine.setSensitivity (fg::Sensitivity::medium);
    engine.setMaxFilters (maxFilters);
    engine.setShiftHz (shiftHz);
    limiter.prepare (sampleRate);

    juce::AudioBuffer<float> block (2, blockSize);
    std::vector<float> previousOutput ((size_t) blockSize, 0.0f);

    const auto totalBlocks = static_cast<int> (seconds * sampleRate / blockSize);
    LoopResult result;

    for (int b = 0; b < totalBlocks; ++b)
    {
        const auto progress = static_cast<float> (b) / static_cast<float> (totalBlocks);
        const auto loopGain = 0.35f + progress * 1.10f;

        float micPeak = 0.0f;

        for (int i = 0; i < blockSize; ++i)
        {
            // Last block's output is what the PA radiated one acoustic delay ago.
            const auto mic = voice.next() + room.process (previousOutput[(size_t) i], loopGain);

            block.setSample (0, i, mic);
            block.setSample (1, i, mic);
            micPeak = juce::jmax (micPeak, std::abs (mic));
        }

        switch (condition)
        {
            case Condition::bypass:                                break;
            case Condition::limiterOnly: limiter.process (block);  break;
            case Condition::fullEngine:  engine.process (block);   break;
        }

        for (int i = 0; i < blockSize; ++i)
            previousOutput[(size_t) i] = block.getSample (0, i);

        const auto db = juce::Decibels::gainToDecibels (juce::jmax (micPeak, 1.0e-7f));
        result.worstMicDb = juce::jmax (result.worstMicDb, db);
        result.finalMicDb = db;

        if (verbose && (b % 94) == 0)
            std::printf ("        t=%4.1fs  loopGain=%.2f  mic=%7.1f dBFS  notches=%d\n",
                         static_cast<float> (b * blockSize / sampleRate), loopGain, db,
                         engine.getSnapshot().activeFilters.load());
    }

    if (condition == Condition::fullEngine)
    {
        result.filters = engine.getSnapshot().activeFilters.load();

        for (size_t i = 0; i < fg::maxFilterSlots; ++i)
            result.filterHz[i] = engine.getSnapshot().filterHz[i].load();
    }

    return result;
}
}

//==============================================================================
int main()
{
    std::printf ("Feedback Guard offline harness  (%.0f Hz, %d-sample blocks)\n\n",
                 sampleRate, blockSize);

    std::printf ("1. Closed acoustic loop, 12 s, loop gain ramped 0.35 -> 1.45\n");
    std::printf ("   Nine room modes, 312 Hz to 6840 Hz; 10.7 ms path\n\n");

    for (auto condition : { Condition::bypass, Condition::limiterOnly })
    {
        const auto r = runLoop (condition, 12.0f, false, 16, 0.0f);
        std::printf ("   %s                        worst mic %7.1f dBFS    final %7.1f dBFS\n",
                     nameOf (condition), r.worstMicDb, r.finalMicDb);
    }

    std::printf ("\n   notches only, no shift -- does a deeper bank help?\n");

    LoopResult full;

    for (const int limit : { 4, 6, 16, 24 })
    {
        const auto r = runLoop (Condition::fullEngine, 12.0f, false, limit, 0.0f);

        std::printf ("      %2d notches max                    worst mic %7.1f dBFS    final %7.1f dBFS    used %d\n",
                     limit, r.worstMicDb, r.finalMicDb, r.filters);

        if (limit == 16)
            full = r;
    }

    std::printf ("\n   shift only, notching disabled -- what does the shifter alone buy?\n");

    for (const float shift : { 0.0f, 3.0f, 5.0f, 8.0f })
    {
        const auto r = runLoop (Condition::fullEngine, 12.0f, false, 0, shift);

        std::printf ("      shift %4.1f Hz, 0 notches          worst mic %7.1f dBFS    final %7.1f dBFS\n",
                     shift, r.worstMicDb, r.finalMicDb);
    }

    std::printf ("\n   both together\n");

    for (const float shift : { 3.0f, 5.0f, 8.0f })
    {
        const auto r = runLoop (Condition::fullEngine, 12.0f, false, 16, shift);

        std::printf ("      shift %4.1f Hz + 16 notches        worst mic %7.1f dBFS    final %7.1f dBFS    used %d\n",
                     shift, r.worstMicDb, r.finalMicDb, r.filters);
    }

    std::printf ("\n   frequencies notched, no shift (%d used):\n", full.filters);

    for (size_t i = 0; i < fg::maxFilterSlots; ++i)
        if (full.filterHz[i] > 0.0f)
            std::printf ("      %6.0f Hz\n", full.filterHz[i]);

    //==========================================================================
    std::printf ("\n1b. Is the shifter really single sideband?\n");

    {
        fg::FrequencyShifter shifter;
        shifter.prepare (sampleRate);
        shifter.setShiftHz (5.0f);

        constexpr float tone = 1000.0f;
        const auto length = static_cast<int> (sampleRate * 4.0);

        juce::AudioBuffer<float> buffer (2, blockSize);
        std::vector<float> captured;
        captured.reserve ((size_t) length);

        int produced = 0;
        float phase = 0.0f;

        while (produced < length)
        {
            for (int i = 0; i < blockSize; ++i)
            {
                const auto v = std::sin (phase);
                phase += juce::MathConstants<float>::twoPi * tone / static_cast<float> (sampleRate);
                if (phase > juce::MathConstants<float>::twoPi) phase -= juce::MathConstants<float>::twoPi;
                buffer.setSample (0, i, v);
                buffer.setSample (1, i, v);
            }

            shifter.process (buffer);

            for (int i = 0; i < blockSize && produced < length; ++i, ++produced)
                captured.push_back (buffer.getSample (0, i));
        }

        // Skip the all-pass settling time before measuring.
        const std::vector<float> steady (captured.begin() + (size_t) sampleRate / 2, captured.end());

        const auto wanted = magnitudeAt (steady, tone + 5.0f);
        const auto image = magnitudeAt (steady, tone - 5.0f);
        const auto leak = magnitudeAt (steady, tone);

        std::printf ("      1000 Hz in, +5 Hz shift\n");
        std::printf ("      wanted  1005 Hz: %6.1f dB\n", juce::Decibels::gainToDecibels (juce::jmax (wanted, 1.0e-7f)));
        std::printf ("      image    995 Hz: %6.1f dB   (rejection %.1f dB)\n",
                     juce::Decibels::gainToDecibels (juce::jmax (image, 1.0e-7f)),
                     juce::Decibels::gainToDecibels (juce::jmax (wanted, 1.0e-7f))
                       - juce::Decibels::gainToDecibels (juce::jmax (image, 1.0e-7f)));
        std::printf ("      carrier 1000 Hz: %6.1f dB\n", juce::Decibels::gainToDecibels (juce::jmax (leak, 1.0e-7f)));

    }

    //==========================================================================
    std::printf ("\n2. Clean voice, no feedback path -- false-positive test\n");

    {
        VoiceSource voice;
        fg::FeedbackGuardEngine engine;
        engine.prepare (sampleRate, blockSize);
        engine.setSensitivity (fg::Sensitivity::medium);
        engine.setShiftHz (5.0f);

        juce::AudioBuffer<float> block (2, blockSize);
        std::vector<float> reference ((size_t) blockSize, 0.0f);

        double inSum = 0.0, outSum = 0.0;
        const auto blocks = static_cast<int> (10.0 * sampleRate / blockSize);

        for (int b = 0; b < blocks; ++b)
        {
            for (int i = 0; i < blockSize; ++i)
            {
                const auto v = voice.next();
                reference[(size_t) i] = v;
                block.setSample (0, i, v);
                block.setSample (1, i, v);
            }

            engine.process (block);

            for (int i = 0; i < blockSize; ++i)
            {
                inSum += static_cast<double> (reference[(size_t) i]) * reference[(size_t) i];
                outSum += static_cast<double> (block.getSample (0, i)) * block.getSample (0, i);
            }
        }

        const auto change = juce::Decibels::gainToDecibels (
            static_cast<float> (std::sqrt (outSum / juce::jmax (1.0, inSum))));

        std::printf ("   level change on clean voice:    %+.2f dB   (want about 0)\n", change);
        std::printf ("   notches placed on clean voice:  %d          (want 0)\n",
                     engine.getSnapshot().activeFilters.load());
    }

    //==========================================================================
    std::printf ("\n3. Cost\n");

    {
        fg::FeedbackGuardEngine engine;
        engine.prepare (sampleRate, blockSize);
        engine.setMaxFilters (fg::maxFilterSlots);

        juce::AudioBuffer<float> block (2, blockSize);
        juce::Random random { 7 };

        for (int i = 0; i < blockSize; ++i)
        {
            const auto v = (random.nextFloat() - 0.5f) * 0.5f;
            block.setSample (0, i, v);
            block.setSample (1, i, v);
        }

        const auto blocks = static_cast<int> (60.0 * sampleRate / blockSize);
        const auto start = juce::Time::getHighResolutionTicks();

        for (int b = 0; b < blocks; ++b)
            engine.process (block);

        const auto elapsed = juce::Time::highResolutionTicksToSeconds (
            juce::Time::getHighResolutionTicks() - start);

        std::printf ("   60 s of stereo audio in %.3f s  ->  %.0fx realtime, %.2f%% of one core\n",
                     elapsed, 60.0 / elapsed, 100.0 * elapsed / 60.0);
    }

    std::printf ("\ndone\n");
    return 0;
}
