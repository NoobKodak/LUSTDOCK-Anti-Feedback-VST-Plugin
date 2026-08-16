#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "DemoGate.h"
#include "FeedbackGuard.h"
#include "Licence.h"
#include "SpectralDenoiser.h"

#include <array>
#include <atomic>

class LostDuckAudioProcessor final : public juce::AudioProcessor,
                                     private juce::AudioProcessorValueTreeState::Listener,
                                     private juce::AsyncUpdater
{
public:
    LostDuckAudioProcessor();
    ~LostDuckAudioProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==============================================================================
    /** Newest audio, decimated to numPoints signed peaks in -1..1, for the scope.
        Aligned to a rising zero crossing so a steady tone stands still on screen. */
    void readScope (float* destination, int numPoints) const;

    float getPeakLevel() const noexcept { return peakLevel.load(); }

    bool isPowerOn() const noexcept { return powerParam != nullptr && powerParam->get(); }
    /** What the parameter allows, and what the shifter is actually using. They differ
        because shifting is engaged only while feedback is a risk. */
    float getShiftCeilingHz() const noexcept { return shiftParam != nullptr ? shiftParam->get() : 0.0f; }
    float getActiveShiftHz() const noexcept { return engine.getSnapshot().activeShiftHz.load(); }
    float getNoiseAmount() const noexcept { return noiseAmountParam != nullptr ? noiseAmountParam->get() : 0.0f; }
    bool isNoiseOn() const noexcept { return noiseOnParam != nullptr && noiseOnParam->get(); }

    const fg::EngineSnapshot& getEngineSnapshot() const noexcept { return engine.getSnapshot(); }

    /** Always true now. The denoiser is our own code compiled into the plug-in, so there
        is nothing to find on the user's machine and nothing that can be missing. Kept as
        a call because the UI reads it, and because a future stage might not be. */
    bool isNoiseReady() const noexcept { return true; }

    //==============================================================================
    bool isActivated() const noexcept { return licence.isActivated(); }
    bool isDemoMuting() const noexcept { return demo.isMuting(); }
    float getDemoSecondsLeft() const noexcept { return demo.getSecondsUntilChange(); }

    /** Message thread. Returns false and changes nothing if the key is not valid. */
    bool activate (const juce::String& key)
    {
        if (! licence.activate (key))
            return false;

        activated.store (true);
        return true;
    }

    void clearNotches() noexcept { engine.requestClear(); }

    juce::AudioProcessorValueTreeState apvts;

private:
    juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void updateLatency();
    void pushScope (const juce::AudioBuffer<float>& buffer, int numSamples);

    /*  The noise switch changes the reported latency, and a host has to be told about
        that from the message thread -- not from inside processBlock. The parameter
        listener fires wherever the change came from, so it only sets a flag and the
        async update does the telling. */
    void parameterChanged (const juce::String& parameterID, float newValue) override;
    void handleAsyncUpdate() override;

    int reportedLatency = -1;

    /** Audio thread only: lets the denoiser be reset once as it is switched out, rather
        than every block. */
    bool noiseWasOn = true;

    fg::FeedbackGuardEngine engine;

    /*  Our own spectral denoiser, compiled in. Nothing is hosted and nothing is looked
        up at runtime, so there is nothing that can go missing on a customer's machine.
        See SpectralDenoiser.h for why it is ours rather than someone else's. */
    SpectralDenoiser denoiser;

    /** Read on the audio thread, written only from the message thread when a key is
        accepted. A plain bool would be a data race; the licence object itself is only
        touched from the message thread. */
    Licence licence;
    std::atomic<bool> activated { false };
    DemoGate demo;

    juce::AudioParameterBool* powerParam = nullptr;
    juce::AudioParameterFloat* shiftParam = nullptr;
    juce::AudioParameterChoice* sensitivityParam = nullptr;
    juce::AudioParameterInt* maxNotchesParam = nullptr;
    juce::AudioParameterFloat* noiseAmountParam = nullptr;
    juce::AudioParameterBool* noiseOnParam = nullptr;

    //==============================================================================
    static constexpr int scopeRingSize = 2048;

    std::array<std::atomic<float>, scopeRingSize> scopeRing {};
    std::atomic<int> scopeWrite { 0 };
    std::atomic<float> peakLevel { 0.0f };

    JUCE_DECLARE_WEAK_REFERENCEABLE (LostDuckAudioProcessor)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LostDuckAudioProcessor)
};
