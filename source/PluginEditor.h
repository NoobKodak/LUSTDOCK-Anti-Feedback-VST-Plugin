#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include "PluginProcessor.h"

class LostDuckAudioProcessorEditor final : public juce::AudioProcessorEditor,
                                           private juce::Timer
{
public:
    explicit LostDuckAudioProcessorEditor (LostDuckAudioProcessor&);
    ~LostDuckAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    juce::WebBrowserComponent::Options buildOptions();
    juce::var describeDetector() const;

    /** Horizontal resolution of the scope. The screen is 579 design px wide, so this
        is a little under three points per pixel at 1:1 -- past that the extra data is
        thrown away by the canvas anyway. */
    static constexpr int scopePoints = 180;

    LostDuckAudioProcessor& processor;

    juce::WebToggleButtonRelay powerRelay { "power" };
    juce::WebSliderRelay noiseRelay { "noise" };
    juce::WebToggleButtonRelay noiseOnRelay { "noiseOn" };
    juce::WebSliderRelay maxNotchesRelay { "maxNotches" };

    juce::WebBrowserComponent webView;

    juce::WebToggleButtonParameterAttachment powerAttachment;
    juce::WebSliderParameterAttachment noiseAttachment;
    juce::WebToggleButtonParameterAttachment noiseOnAttachment;
    juce::WebSliderParameterAttachment maxNotchesAttachment;

    std::array<float, scopePoints> scopeScratch {};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LostDuckAudioProcessorEditor)
};
