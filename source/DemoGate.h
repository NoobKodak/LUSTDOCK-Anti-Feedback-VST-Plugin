#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>

/** Silences the output periodically until the plug-in is activated.

    Fifteen seconds of audio, ten seconds of silence, repeating. Long enough to judge
    whether the thing works, short enough that nobody gigs on it.

    Two details that matter more than they look:

      - The transitions are faded over 30 ms. A hard gate clicks, and a click through a
        PA at show level is worse than the silence it announces.
      - Timing is counted in samples, not blocks, so it does not drift with buffer size
        and behaves the same at 44.1 and 48 kHz.

    This runs on the output, after the feedback engine, so the detector keeps analysing
    through the silent stretch and does not lose its notches every 25 seconds.
*/
class DemoGate
{
public:
    void prepare (double sampleRate);
    void reset();

    /** Applies the gate. Does nothing at all when activated. */
    void process (juce::AudioBuffer<float>& buffer, bool activated);

    /** For the screen: whether audio is currently being silenced, and how many seconds
        until that changes. */
    bool isMuting() const noexcept { return muting.load (std::memory_order_relaxed); }
    float getSecondsUntilChange() const noexcept { return secondsUntilChange.load (std::memory_order_relaxed); }

private:
    static constexpr double audibleSeconds = 15.0;
    static constexpr double mutedSeconds = 10.0;
    static constexpr double fadeSeconds = 0.03;

    double sr = 48000.0;
    juce::int64 position = 0;
    juce::int64 cycleLength = 0;
    juce::int64 audibleLength = 0;
    int fadeLength = 1;

    float gain = 1.0f;

    // Written on the audio thread, read by the editor's timer.
    std::atomic<bool> muting { false };
    std::atomic<float> secondsUntilChange { 0.0f };
};
