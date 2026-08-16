#include "DemoGate.h"

void DemoGate::prepare (double sampleRate)
{
    sr = sampleRate > 0.0 ? sampleRate : 48000.0;
    audibleLength = static_cast<juce::int64> (audibleSeconds * sr);
    cycleLength = static_cast<juce::int64> ((audibleSeconds + mutedSeconds) * sr);
    fadeLength = juce::jmax (1, static_cast<int> (fadeSeconds * sr));
    reset();
}

void DemoGate::reset()
{
    position = 0;
    gain = 1.0f;
    muting.store (false, std::memory_order_relaxed);
    secondsUntilChange.store (static_cast<float> (audibleSeconds), std::memory_order_relaxed);
}

void DemoGate::process (juce::AudioBuffer<float>& buffer, bool activated)
{
    if (activated)
    {
        // Nothing to undo: an activated plug-in has never touched the gain, and the
        // moment a key is accepted the audio comes straight back.
        gain = 1.0f;
        muting.store (false, std::memory_order_relaxed);
        secondsUntilChange.store (0.0f, std::memory_order_relaxed);
        return;
    }

    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = buffer.getNumChannels();

    if (numSamples <= 0 || numChannels <= 0 || cycleLength <= 0)
        return;

    const auto fadeStep = 1.0f / static_cast<float> (fadeLength);

    for (int i = 0; i < numSamples; ++i)
    {
        const auto inCycle = position % cycleLength;
        const auto wantAudible = inCycle < audibleLength;

        // Ramp toward the target rather than jumping to it.
        gain = wantAudible ? juce::jmin (1.0f, gain + fadeStep)
                           : juce::jmax (0.0f, gain - fadeStep);

        for (int ch = 0; ch < numChannels; ++ch)
            buffer.getWritePointer (ch)[i] *= gain;

        ++position;
    }

    const auto inCycle = position % cycleLength;
    const auto nowMuting = inCycle >= audibleLength;
    muting.store (nowMuting, std::memory_order_relaxed);

    const auto remaining = nowMuting ? cycleLength - inCycle : audibleLength - inCycle;
    secondsUntilChange.store (static_cast<float> (static_cast<double> (remaining) / sr),
                              std::memory_order_relaxed);
}
