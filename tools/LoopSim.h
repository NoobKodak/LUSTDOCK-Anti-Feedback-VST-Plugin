#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>
#include <vector>

/** Shared closed-loop simulation: microphone -> plug-in -> PA -> room -> microphone.

    Used by both the development harness, which runs one fixed room, and the AGBF bench,
    which runs hundreds of randomised ones. Keeping the physics in one place means the
    two tools cannot quietly disagree about what "a room" is.
*/
namespace sim
{
//==============================================================================
/** One resonant mode. RBJ band-pass, unity gain at resonance, so the loop gain
    multiplier is exactly the round-trip gain at the mode frequency. */
struct Resonator
{
    void set (double sampleRate, float hz, float q, float weight = 1.0f)
    {
        const auto omega = juce::MathConstants<float>::twoPi * hz / static_cast<float> (sampleRate);
        const auto alpha = std::sin (omega) / (2.0f * q);
        const auto cosw = std::cos (omega);
        const auto a0 = 1.0f + alpha;

        b0 = alpha / a0 * weight;
        b2 = -alpha / a0 * weight;
        a1 = -2.0f * cosw / a0;
        a2 = (1.0f - alpha) / a0;
        reset();
    }

    void reset() { z1 = z2 = 0.0f; }

    float process (float x)
    {
        const auto y = b0 * x + z1;
        z1 = -a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }

    float b0 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
};

struct Mode
{
    float hz = 1000.0f;
    float q = 40.0f;
    float weight = 1.0f;
};

//==============================================================================
/** The acoustic path. Whatever the PA radiates comes back to the microphone one
    propagation delay later, coloured by the room's modes and scaled by the loop gain.

    The delay is explicit rather than "one processing block", so distance can be varied
    independently of buffer size. It must be at least one block long, which is also
    physically sensible -- a microphone closer than that to the speaker is not a PA, it
    is a fault.
*/
class Room
{
public:
    void prepare (double sampleRate, int delaySamples, int maximumBlockSize,
                  const std::vector<Mode>& modeList)
    {
        // The read for sample n needs the value written at n - delay. Reads for a block
        // all happen before that block's writes, so the delay has to be at least one
        // block or the loop would need a sample that does not exist yet.
        delay = juce::jmax (maximumBlockSize, delaySamples);
        length = delay + 2 * maximumBlockSize;
        line.assign ((size_t) length, 0.0f);

        modes.clear();

        for (const auto& m : modeList)
        {
            Resonator r;
            r.set (sampleRate, m.hz, m.q, m.weight);
            modes.push_back (r);
        }

        reset();
    }

    void reset()
    {
        std::fill (line.begin(), line.end(), 0.0f);
        readCount = 0;
        writeCount = 0;

        for (auto& m : modes)
            m.reset();
    }

    /** What arrives at the microphone for this sample. Called once per sample, in
        order; reads and writes each advance their own counter, which is what keeps the
        path a real delay line rather than a value held for a whole block. */
    float readArrival (float loopGain)
    {
        const auto delayed = readCount >= delay
                           ? line[(size_t) ((readCount - delay) % length)]
                           : 0.0f;

        ++readCount;

        float summed = 0.0f;

        for (auto& m : modes)
            summed += m.process (delayed);

        // Real rooms and real PAs saturate. Without this a diverging loop runs to
        // infinity and every measurement downstream becomes meaningless.
        return juce::jlimit (-8.0f, 8.0f, summed * loopGain);
    }

    /** What the PA radiated for this sample. */
    void push (float speaker)
    {
        line[(size_t) (writeCount % length)] = speaker;
        ++writeCount;
    }

    int getDelaySamples() const { return delay; }

private:
    std::vector<Resonator> modes;
    std::vector<float> line;
    long long readCount = 0;
    long long writeCount = 0;
    int delay = 512;
    int length = 2048;
};

//==============================================================================
/** A vocal-ish source: harmonic series with vibrato and a little breath noise.
    Deliberately tonal, because that is exactly what a naive detector notches. */
class VoiceSource
{
public:
    explicit VoiceSource (float fundamentalHz = 196.0f, int seed = 20260808)
        : fundamental (fundamentalHz), random (seed) {}

    void prepare (double sr) { sampleRate = sr; }

    void reset()
    {
        phase = 0.0f;
        vibratoPhase = 0.0f;
    }

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
    float fundamental;
    juce::Random random;
    double sampleRate = 48000.0;
    float phase = 0.0f;
    float vibratoPhase = 0.0f;
};

//==============================================================================
/** Programme material for the transparency tests.
 *
 *  The original corpus was four voices, all built as seven harmonics falling at 1/h^2.
 *  That is a dense, rich series -- precisely the case harmonic rejection finds easy --
 *  and it reported zero false positives while the plug-in was busy notching instruments
 *  in the real world. These are the awkward cases: sparse spectra, fundamentals below
 *  and above the detection band, and a pure tone with no series at all.
 */
class ToneSource
{
public:
    struct Spec
    {
        const char* name = "tone";
        float fundamental = 440.0f;
        int harmonics = 7;
        float rolloff = 2.0f;     // amplitude divided by h^rolloff
        float vibratoCents = 0.0f;
        float amplitude = 0.22f;
    };

    ToneSource (const Spec& s, int seed = 1234) : spec (s), random (seed) {}

    void prepare (double sr) { sampleRate = sr; }

    float next()
    {
        const auto wobble = spec.vibratoCents > 0.0f
                          ? 1.0f + (spec.vibratoCents / 1200.0f) * std::sin (vibratoPhase)
                          : 1.0f;

        phase += juce::MathConstants<float>::twoPi * spec.fundamental * wobble / static_cast<float> (sampleRate);
        vibratoPhase += juce::MathConstants<float>::twoPi * 5.0f / static_cast<float> (sampleRate);

        if (phase > juce::MathConstants<float>::twoPi) phase -= juce::MathConstants<float>::twoPi;
        if (vibratoPhase > juce::MathConstants<float>::twoPi) vibratoPhase -= juce::MathConstants<float>::twoPi;

        float sum = 0.0f;

        for (int h = 1; h <= spec.harmonics; ++h)
            sum += std::sin (phase * static_cast<float> (h)) / std::pow (static_cast<float> (h), spec.rolloff);

        return sum * spec.amplitude + (random.nextFloat() - 0.5f) * 0.0004f;
    }

private:
    Spec spec;
    juce::Random random;
    double sampleRate = 48000.0;
    float phase = 0.0f;
    float vibratoPhase = 0.0f;
};

/** Sung vowels interrupted by consonants: the case that exposed notches landing at
 *  8.7, 9.3 and 9.8 kHz on a real vocal. Sibilance is broadband and transient, so it
 *  should never earn a notch -- but a narrowness test measured over 70 Hz cannot tell
 *  the difference, and a confirmation window shorter than a consonant lets it through. */
class SingingSource
{
public:
    explicit SingingSource (int seed = 99) : random (seed) {}

    void prepare (double sr) { sampleRate = sr; }

    float next()
    {
        elapsed += 1.0f / static_cast<float> (sampleRate);

        // Alternate roughly 350 ms of vowel with 120 ms of consonant.
        if (elapsed > (sibilant ? 0.12f : 0.35f))
        {
            elapsed = 0.0f;
            sibilant = ! sibilant;

            if (! sibilant)
                fundamental = 180.0f * std::pow (2.0f, random.nextFloat() * 0.6f);
        }

        if (sibilant)
        {
            // Band-limited hiss around 5-10 kHz: two one-pole highpasses on white noise.
            const auto white = random.nextFloat() * 2.0f - 1.0f;
            hp1 = 0.72f * (hp1 + white - lastWhite);
            lastWhite = white;
            hp2 = 0.72f * (hp2 + hp1 - lastHp1);
            lastHp1 = hp1;
            return hp2 * 0.30f;
        }

        phase += juce::MathConstants<float>::twoPi * fundamental / static_cast<float> (sampleRate);

        if (phase > juce::MathConstants<float>::twoPi)
            phase -= juce::MathConstants<float>::twoPi;

        float sum = 0.0f;

        for (int h = 1; h <= 8; ++h)
            sum += std::sin (phase * static_cast<float> (h)) / static_cast<float> (h * h);

        return sum * 0.24f;
    }

private:
    juce::Random random;
    double sampleRate = 48000.0;
    float elapsed = 0.0f;
    bool sibilant = false;
    float fundamental = 196.0f;
    float phase = 0.0f;
    float hp1 = 0.0f, hp2 = 0.0f, lastWhite = 0.0f, lastHp1 = 0.0f;
};

inline float dbOf (float linear)
{
    return juce::Decibels::gainToDecibels (juce::jmax (linear, 1.0e-7f));
}

/** A plausible room: a spread of modes, hotter in the mid where microphones and PAs
    actually ring, with one or two dominant ones as real rooms have. */
inline std::vector<Mode> makeRandomRoom (juce::Random& random, int numModes)
{
    std::vector<Mode> modes;
    modes.reserve ((size_t) numModes);

    for (int i = 0; i < numModes; ++i)
    {
        Mode m;

        // Log-uniform across the band feedback actually lives in.
        const auto t = random.nextFloat();
        m.hz = 150.0f * std::pow (8000.0f / 150.0f, t);
        m.q = 25.0f + random.nextFloat() * 35.0f;

        // Most modes are secondary; a couple dominate. That spread is what makes
        // feedback migrate when the loudest one is notched.
        m.weight = 0.45f + random.nextFloat() * 0.55f;

        if (i < 2)
            m.weight = 1.0f;

        modes.push_back (m);
    }

    return modes;
}
}
