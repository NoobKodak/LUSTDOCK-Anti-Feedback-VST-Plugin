#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <cmath>

namespace
{
constexpr int parameterVersion = 1;
}

//==============================================================================
juce::AudioProcessorValueTreeState::ParameterLayout LostDuckAudioProcessor::createLayout()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    // The whole control surface: the big orange button. On means the detector is
    // running and its notches are in circuit; off is a true bypass.
    layout.add (std::make_unique<juce::AudioParameterBool> (
        juce::ParameterID { "power", parameterVersion }, "Power", true,
        juce::AudioParameterBoolAttributes{}.withStringFromValueFunction (
            [] (bool on, int) { return on ? juce::String ("ON") : juce::String ("OFF"); })));

    // Not on the front panel -- the casing has one button -- but it changes the sound,
    // so it is automatable and visible in the host. 5 Hz is inaudible on speech and
    // buys more gain before feedback than the whole notch bank does. Set it to 0 for
    // sustained tonal sources, where a few Hz of offset can shimmer.
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "shift", parameterVersion }, "Frequency Shift",
        juce::NormalisableRange<float> { 0.0f, 12.0f, 0.5f }, 5.0f,
        juce::AudioParameterFloatAttributes{}.withStringFromValueFunction (
            [] (float hz, int) { return hz <= 0.0f ? juce::String ("OFF")
                                                   : juce::String (hz, 1) + " Hz"; })));

    // The Noise knob. Starts at zero so loading the plug-in never quietly starts
    // removing things from the signal.
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "noise", parameterVersion }, "Noise",
        juce::NormalisableRange<float> { 0.0f, 1.0f }, 0.0f,
        juce::AudioParameterFloatAttributes{}.withStringFromValueFunction (
            [] (float v, int) { return juce::String (juce::roundToInt (v * 100.0f)) + "%"; })));

    // Not on the panel, but the one knob worth having when the plug-in is on material
    // it was not designed for. Low is the safe setting for anything but a live mic.
    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { "sensitivity", parameterVersion }, "Sensitivity",
        juce::StringArray { "Low", "Medium", "High" }, 1));

    // How many notches the bank may place at once. Every notch takes something out of
    // the voice, and the bench shows the bank plateaus around six in a normal room --
    // so this is a damage limit, not a capability dial. Raising it does not catch more
    // feedback; it only allows more of the spectrum to be removed when things go wrong.
    layout.add (std::make_unique<juce::AudioParameterInt> (
        juce::ParameterID { "maxNotches", parameterVersion }, "Max Notches",
        1, fg::maxFilterSlots, 6,
        juce::AudioParameterIntAttributes{}.withStringFromValueFunction (
            [] (int v, int) { return juce::String (v); })));

    /*  Off by default, and that is the difference between a zero latency plug-in and a
        10 ms one.

        The denoiser is the only thing in the signal path that delays anything. Left
        switched on it charged every session 10 ms whether or not the knob was above
        zero -- which, since the knob also starts at zero, was 10 ms for nothing at all.
        Anti-feedback is what this is for; noise reduction is an extra you opt into and
        pay for when you do. */
    layout.add (std::make_unique<juce::AudioParameterBool> (
        juce::ParameterID { "noiseOn", parameterVersion }, "Noise Enable", false,
        juce::AudioParameterBoolAttributes{}.withStringFromValueFunction (
            [] (bool on, int) { return on ? juce::String ("ON") : juce::String ("OFF"); })));

    return layout;
}

//==============================================================================
LostDuckAudioProcessor::LostDuckAudioProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "LostDuck", createLayout())
{
    // The switch changes the reported latency, so the host has to hear about it.
    apvts.addParameterListener ("noiseOn", this);

    powerParam = dynamic_cast<juce::AudioParameterBool*> (apvts.getParameter ("power"));
    shiftParam = dynamic_cast<juce::AudioParameterFloat*> (apvts.getParameter ("shift"));
    sensitivityParam = dynamic_cast<juce::AudioParameterChoice*> (apvts.getParameter ("sensitivity"));
    noiseAmountParam = dynamic_cast<juce::AudioParameterFloat*> (apvts.getParameter ("noise"));
    noiseOnParam = dynamic_cast<juce::AudioParameterBool*> (apvts.getParameter ("noiseOn"));
    maxNotchesParam = dynamic_cast<juce::AudioParameterInt*> (apvts.getParameter ("maxNotches"));

}

LostDuckAudioProcessor::~LostDuckAudioProcessor()
{
    apvts.removeParameterListener ("noiseOn", this);
    cancelPendingUpdate();
}

void LostDuckAudioProcessor::updateLatency()
{
    /*  Zero unless the noise reduction is actually switched on.

        The feedback engine -- the whole point of the plug-in -- is zero latency by
        construction: shifting and notching are both sample-by-sample. The only delay
        anywhere is the denoiser's analysis window, and it is nonsense to charge a
        singer 10 ms for a stage they are not using. With the switch off the denoiser is
        skipped entirely and the plug-in is genuinely zero latency.

        The number changes when the switch moves, so this is called from the message
        thread via handleAsyncUpdate rather than from processBlock. */
    const auto latency = isNoiseOn() ? denoiser.getLatencySamples() : 0;

    if (latency != reportedLatency)
    {
        reportedLatency = latency;
        setLatencySamples (latency);
    }
}

void LostDuckAudioProcessor::parameterChanged (const juce::String& parameterID, float)
{
    if (parameterID == "noiseOn")
        triggerAsyncUpdate();
}

void LostDuckAudioProcessor::handleAsyncUpdate()
{
    updateLatency();
}

//==============================================================================
void LostDuckAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    for (auto& sample : scopeRing)
        sample.store (0.0f, std::memory_order_relaxed);

    scopeWrite.store (0, std::memory_order_release);
    peakLevel.store (0.0f);

    engine.prepare (sampleRate, samplesPerBlock);
    denoiser.prepare (sampleRate, samplesPerBlock, getTotalNumOutputChannels());
    demo.prepare (sampleRate);
    activated.store (licence.isActivated());

    // The feedback engine is zero-latency by construction. The denoiser is not, so the
    // host is told what to compensate for -- and only while it is switched on.
    updateLatency();
}

void LostDuckAudioProcessor::releaseResources()
{
    engine.reset();
    denoiser.reset();
}

bool LostDuckAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();

    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;

    return layouts.getMainInputChannelSet() == out;
}

void LostDuckAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;

    const auto numSamples = buffer.getNumSamples();
    const auto numChannels = buffer.getNumChannels();

    for (int ch = getTotalNumInputChannels(); ch < getTotalNumOutputChannels(); ++ch)
        buffer.clear (ch, 0, numSamples);

    if (numSamples <= 0 || numChannels <= 0)
        return;

    if (isPowerOn())
    {
        if (shiftParam != nullptr)
            engine.setShiftHz (shiftParam->get());

        if (sensitivityParam != nullptr)
            engine.setSensitivity (static_cast<fg::Sensitivity> (sensitivityParam->getIndex()));

        if (maxNotchesParam != nullptr)
            engine.setMaxFilters (maxNotchesParam->get());

        // Feedback control first, noise reduction second. A denoiser would otherwise
        // strip the quiet beginning of a feedback tone before the detector ever sees
        // it, which is exactly the part that needs catching.
        engine.process (buffer);

        /*  Skipped outright when the switch is off, so the plug-in reports and costs
            zero latency -- see updateLatency.

            The two have to agree: the host is told 0 the moment the switch goes off, so
            the stage must genuinely stop delaying at the same time. Resetting on the way
            out means it primes from silence when it comes back rather than replaying
            whatever was in its buffers. */
        const auto wantNoise = isNoiseOn();

        if (wantNoise)
        {
            denoiser.process (buffer, getNoiseAmount());
        }
        else if (noiseWasOn)
        {
            denoiser.reset();
        }

        noiseWasOn = wantNoise;
    }

    // Last, on the way out. Deliberately after the engine so the detector keeps
    // analysing through the silent stretch instead of losing its notches every cycle.
    demo.process (buffer, activated.load());

    pushScope (buffer, numSamples);

    const auto peak = buffer.getMagnitude (0, numSamples);
    const auto previousPeak = peakLevel.load();
    peakLevel.store (juce::jmax (peak, previousPeak * 0.85f));
}

void LostDuckAudioProcessor::pushScope (const juce::AudioBuffer<float>& buffer, int numSamples)
{
    const auto numChannels = buffer.getNumChannels();
    const auto* left = buffer.getReadPointer (0);
    const auto* right = numChannels > 1 ? buffer.getReadPointer (1) : left;

    auto write = scopeWrite.load (std::memory_order_relaxed);

    for (int i = 0; i < numSamples; ++i)
    {
        scopeRing[(size_t) write].store (0.5f * (left[i] + right[i]), std::memory_order_relaxed);
        write = (write + 1) & (scopeRingSize - 1);
    }

    scopeWrite.store (write, std::memory_order_release);
}

void LostDuckAudioProcessor::readScope (float* destination, int numPoints) const
{
    if (destination == nullptr || numPoints <= 0)
        return;

    // Oldest first, so local[scopeRingSize - 1] is the newest sample.
    std::array<float, scopeRingSize> local {};
    const auto write = scopeWrite.load (std::memory_order_acquire);

    for (int i = 0; i < scopeRingSize; ++i)
        local[(size_t) i] = scopeRing[(size_t) ((write + i) & (scopeRingSize - 1))].load (std::memory_order_relaxed);

    constexpr int window = scopeRingSize / 2;
    int start = scopeRingSize - window;

    // Walk back to the most recent rising zero crossing. A steady tone then redraws in
    // the same place every frame instead of sliding across the screen.
    for (int i = start; i > 0; --i)
    {
        if (local[(size_t) (i - 1)] <= 0.0f && local[(size_t) i] > 0.0f)
        {
            start = i;
            break;
        }
    }

    for (int p = 0; p < numPoints; ++p)
    {
        const auto from = start + (p * window) / numPoints;
        const auto to = juce::jmax (from + 1, start + ((p + 1) * window) / numPoints);

        float peak = 0.0f;

        for (int i = from; i < to && i < scopeRingSize; ++i)
            if (std::abs (local[(size_t) i]) > std::abs (peak))
                peak = local[(size_t) i];

        destination[p] = peak;
    }
}

//==============================================================================
void LostDuckAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (const auto xml = apvts.copyState().createXml())
        copyXmlToBinary (*xml, destData);
}

void LostDuckAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    const auto xml = getXmlFromBinary (data, sizeInBytes);

    if (xml == nullptr || ! xml->hasTagName (apvts.state.getType()))
        return;

    auto state = juce::ValueTree::fromXml (*xml);

    // Sessions saved by the NS1 build carry a hosted-plug-in blob. It is meaningless
    // now, so it is dropped rather than left to confuse the parameter tree.
    state.removeChild (state.getChildWithName ("noiseBackend"), nullptr);

    apvts.replaceState (state);
}

//==============================================================================
juce::AudioProcessorEditor* LostDuckAudioProcessor::createEditor()
{
    return new LostDuckAudioProcessorEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new LostDuckAudioProcessor();
}
