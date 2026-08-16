#include "PluginEditor.h"
#include "WebResourceProvider.h"

namespace
{
// The casing artwork's own pixel size. Everything in the React app is authored in
// this space and scaled with one CSS transform, so these two numbers and the ones in
// ui/src/layout.ts are the only place the geometry lives.
constexpr int designWidth = 1430;
constexpr int designHeight = 804;
constexpr double designRatio = (double) designWidth / (double) designHeight;

juce::var makeObject (std::initializer_list<std::pair<const char*, juce::var>> properties)
{
    auto* object = new juce::DynamicObject();

    for (const auto& [key, value] : properties)
        object->setProperty (key, value);

    return { object };
}
}

//==============================================================================
LostDuckAudioProcessorEditor::LostDuckAudioProcessorEditor (LostDuckAudioProcessor& p)
    : AudioProcessorEditor (&p),
      processor (p),
      webView (buildOptions()),
      powerAttachment (*processor.apvts.getParameter ("power"), powerRelay, processor.apvts.undoManager),
      noiseAttachment (*processor.apvts.getParameter ("noise"), noiseRelay, processor.apvts.undoManager),
      noiseOnAttachment (*processor.apvts.getParameter ("noiseOn"), noiseOnRelay, processor.apvts.undoManager),
      maxNotchesAttachment (*processor.apvts.getParameter ("maxNotches"), maxNotchesRelay, processor.apvts.undoManager)
{
    addAndMakeVisible (webView);

#if LOSTDUCK_DEV_SERVER
    webView.goToURL ("http://localhost:5173/");
#else
    webView.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
#endif

    setResizable (true, true);
    setResizeLimits (designWidth / 4, designHeight / 4, designWidth * 2, designHeight * 2);
    getConstrainer()->setFixedAspectRatio (designRatio);
    setSize (designWidth / 2, designHeight / 2);

    /*  Someone holding a key from before online activation gets moved across, quietly,
        the first time they open the window.

        Here and not in the processor's constructor: hosts build a processor purely to
        scan the plug-in, so doing this there would fire an HTTP request during every
        DAW's scan on every machine, whether or not the plug-in is ever opened.       */
    processor.migrateOldLicenceIfNeeded();

    startTimerHz (30);
}

LostDuckAudioProcessorEditor::~LostDuckAudioProcessorEditor()
{
    stopTimer();
}

//==============================================================================
juce::WebBrowserComponent::Options LostDuckAudioProcessorEditor::buildOptions()
{
    using Options = juce::WebBrowserComponent::Options;
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;

    return Options{}
        .withBackend (Options::Backend::webview2)
        .withWinWebView2Options (Options::WinWebView2{}
            .withBackgroundColour (juce::Colours::white)
            .withUserDataFolder (juce::File::getSpecialLocation (juce::File::tempDirectory)))
        .withNativeIntegrationEnabled()
        .withResourceProvider ([] (const auto& url) { return lostduck::getWebResource (url); },
                               juce::URL { "http://localhost:5173" }.getOrigin())
        .withOptionsFrom (powerRelay)
        .withOptionsFrom (noiseRelay)
        .withOptionsFrom (noiseOnRelay)
        .withOptionsFrom (maxNotchesRelay)
        .withNativeFunction ("getDetectorState", [this] (const juce::Array<juce::var>&, Completion complete)
        {
            complete (describeDetector());
        })
        .withNativeFunction ("clearNotches", [this] (const juce::Array<juce::var>&, Completion complete)
        {
            processor.clearNotches();
            complete (describeDetector());
        })
        /*  Activation now asks a server, so it takes as long as the customer's connection
            takes. The bridge already hands us a completion callback, so the answer is
            simply delivered late rather than the interface freezing while a slow hotel
            wifi times out -- the screen keeps drawing and the audio keeps running.

            `message` is passed straight through to the UI. The server writes sentences a
            musician can act on ("this key is already active on 3 computers"), and
            flattening those into a boolean would throw away the only thing that tells
            somebody what to do next.                                                   */
        .withNativeFunction ("activate", [this] (const juce::Array<juce::var>& args, Completion complete)
        {
            const auto key = args.isEmpty() ? juce::String() : args[0].toString();

            processor.activateAsync (key, [this, complete] (Activation::Outcome outcome)
            {
                complete (makeObject ({ { "ok", outcome.ok },
                                        { "message", outcome.message },
                                        { "offline", outcome.offline },
                                        { "activated", processor.isActivated() } }));
            });
        });
}

juce::var LostDuckAudioProcessorEditor::describeDetector() const
{
    const auto& snapshot = processor.getEngineSnapshot();

    juce::Array<juce::var> notches;

    for (const auto& hz : snapshot.filterHz)
        if (const auto frequency = hz.load(); frequency > 0.0f)
            notches.add (juce::var ((double) frequency));

    return makeObject ({
        { "notches",     notches },
        { "candidateHz", snapshot.candidateHz.load() },
        { "confidence",  snapshot.confidence.load() },
        { "deepestDb",   snapshot.deepestDepthDb.load() },
        { "shiftHz",     processor.getActiveShiftHz() },
        { "shiftMaxHz",  processor.getShiftCeilingHz() },
        // Toggle positions come from the parameters rather than the relays. The relays
        // drive writes and host automation, but their JS side starts false and only
        // becomes true once an async round trip completes -- reading them for display
        // means the UI can briefly, or permanently, disagree with the audio engine.
        { "power",       processor.isPowerOn() },
        { "noiseOn",     processor.isNoiseOn() },
        { "noiseAmount", processor.getNoiseAmount() },
        // The denoiser is compiled in, so it is either present or the build is broken.
        // Its name is deliberately not reported: the screen says what the control does,
        // not which library sits behind it.
        { "noiseReady",  processor.isNoiseReady() },
        { "activated",   processor.isActivated() },
        { "demoMuting",  processor.isDemoMuting() },
        { "demoSeconds", processor.getDemoSecondsLeft() },
    });
}

//==============================================================================
void LostDuckAudioProcessorEditor::timerCallback()
{
    processor.readScope (scopeScratch.data(), scopePoints);

    juce::Array<juce::var> points;
    points.ensureStorageAllocated (scopePoints);

    for (const auto sample : scopeScratch)
        points.add (juce::var ((double) sample));

    // One event carries the whole frame. The detector payload is a handful of numbers,
    // so splitting it out would cost a second round trip for no gain.
    webView.emitEventIfBrowserIsVisible ("lostduck:frame", makeObject ({
        { "points",   points },
        { "peak",     processor.getPeakLevel() },
        { "detector", describeDetector() } }));
}

void LostDuckAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colours::white);
}

void LostDuckAudioProcessorEditor::resized()
{
    webView.setBounds (getLocalBounds());
}
