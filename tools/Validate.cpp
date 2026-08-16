/*  Host-side validation.

    Does to the plug-in roughly what a DAW's scanner does, in order, printing each step
    before it runs so that a hang or a crash names the step it died on rather than
    leaving a silent failure.

    Written because FL Studio refused to verify the plug-in and its log said nothing at
    all about why -- it simply never wrote the entry.

    Usage:  LostDuckValidate [path-to.vst3]
*/

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include <cstdio>

namespace
{
void step (const char* what)
{
    std::printf ("  %-46s", what);
    std::fflush (stdout);
}

void ok (const char* detail = nullptr)
{
    std::printf ("ok%s%s\n", detail != nullptr ? "  " : "", detail != nullptr ? detail : "");
    std::fflush (stdout);
}
}

int main (int argc, char** argv)
{
    const juce::ScopedJuceInitialiser_GUI juceInit;

    const juce::String path = argc >= 2
        ? juce::String (argv[1])
        : "C:\\Program Files\\Common Files\\VST3\\LOST DUCK Anti Feedback Ai.vst3";

    std::printf ("LOST Duck -- plug-in validation\n%s\n\n", path.toRawUTF8());

    juce::VST3PluginFormat format;
    juce::OwnedArray<juce::PluginDescription> found;

    step ("scanning the bundle");
    juce::KnownPluginList list;
    list.scanAndAddFile (path, true, found, format);

    if (found.isEmpty())
    {
        std::printf ("FAILED -- the format reported no plug-ins in this file.\n");
        return 1;
    }

    ok (juce::String (found.size()).toRawUTF8());

    for (auto* description : found)
    {
        std::printf ("\n== %s  (%s, %s)\n", description->name.toRawUTF8(),
                     description->manufacturerName.toRawUTF8(),
                     description->version.toRawUTF8());

        step ("creating an instance");
        juce::String error;
        auto instance = format.createInstanceFromDescription (*description, 48000.0, 512, error);

        if (instance == nullptr)
        {
            std::printf ("FAILED\n    %s\n", error.toRawUTF8());
            return 1;
        }

        ok();

        // A scanner asks what the plug-in can do before it commits to a layout.
        step ("querying bus layouts");
        std::printf ("in %d / out %d  ", instance->getTotalNumInputChannels(),
                     instance->getTotalNumOutputChannels());
        ok();

        /*  Several rates and block sizes, with real signal rather than silence.

            44.1 kHz puts the denoiser through its resampler, and a block size that is
            not a multiple of the denoiser's analysis window is what exposed the buffering
            bug that made the noise control sound gated. Silence would have hidden both. */
        for (const auto rate : { 48000.0, 44100.0, 96000.0 })
        {
            for (const auto blockSize : { 512, 128, 1024 })
            {
                char label[64];
                std::snprintf (label, sizeof (label), "%.1fk / %d block", rate / 1000.0, blockSize);
                step (label);

                instance->prepareToPlay (rate, blockSize);

                juce::AudioBuffer<float> buffer (juce::jmax (2, instance->getTotalNumOutputChannels()),
                                                 blockSize);
                juce::MidiBuffer midi;
                double phase = 0.0;
                const auto delta = juce::MathConstants<double>::twoPi * 220.0 / rate;

                float peak = 0.0f;
                bool sane = true;

                // Long enough to get well past the priming stretch at every rate.
                for (int block = 0; block < 200; ++block)
                {
                    for (int i = 0; i < blockSize; ++i)
                    {
                        const auto s = static_cast<float> (0.25 * std::sin (phase));
                        phase += delta;

                        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
                            buffer.setSample (ch, i, s);
                    }

                    instance->processBlock (buffer, midi);

                    if (block < 40)
                        continue;   // still settling

                    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
                    {
                        const auto* out = buffer.getReadPointer (ch);

                        for (int i = 0; i < blockSize; ++i)
                        {
                            const auto v = out[i];

                            if (! std::isfinite (v) || std::abs (v) > 4.0f)
                                sane = false;

                            peak = juce::jmax (peak, std::abs (v));
                        }
                    }
                }

                if (! sane)
                {
                    std::printf ("FAILED -- non-finite or out-of-range output\n");
                    return 1;
                }

                char detail[64];
                std::snprintf (detail, sizeof (detail), "peak %.3f", peak);
                ok (detail);
            }
        }

        instance->prepareToPlay (48000.0, 512);

        /*  Latency is the headline claim, so it is checked rather than assumed: zero as
            loaded, and -- since the denoiser's analysis runs beside the signal rather
            than in front of it -- still zero with the noise switch on. This check is
            the reason to trust the claim on the box. */
        step ("latency as loaded");
        {
            instance->prepareToPlay (48000.0, 512);
            const auto idle = instance->getLatencySamples();
            std::printf ("%d samples  ", idle);

            if (idle != 0)
            {
                std::printf ("FAILED -- expected zero with the noise switch off\n");
                return 1;
            }
        }
        ok();

        step ("latency with noise switched on");
        {
            for (auto* parameter : instance->getParameters())
            {
                if (parameter->getName (64).equalsIgnoreCase ("Noise Enable"))
                {
                    parameter->setValueNotifyingHost (1.0f);
                    break;
                }
            }

            // The change is announced from the message thread, so let it land.
            juce::MessageManager::getInstance()->runDispatchLoopUntil (250);
            instance->prepareToPlay (48000.0, 512);

            const auto engaged = instance->getLatencySamples();
            std::printf ("%d samples  ", engaged);

            if (engaged != 0)
            {
                std::printf ("FAILED -- the noise stage must not introduce delay\n");
                return 1;
            }
        }
        ok();

        step ("getStateInformation");
        juce::MemoryBlock state;
        instance->getStateInformation (state);
        ok (juce::String (state.getSize()).toRawUTF8());

        step ("setStateInformation");
        instance->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        ok();

        // The step most likely to be the problem: a scanner opens the editor to learn
        // how big it is, and this plug-in's editor builds a WebView.
        step ("hasEditor / createEditor");

        if (instance->hasEditor())
        {
            if (auto* editor = instance->createEditorIfNeeded())
            {
                std::printf ("%d x %d  ", editor->getWidth(), editor->getHeight());

                // Pump the message loop briefly: WebView2 comes up asynchronously, and
                // anything it does wrong tends to happen just after construction.
                juce::MessageManager::getInstance()->runDispatchLoopUntil (2500);

                instance->editorBeingDeleted (editor);
                delete editor;
                ok();
            }
            else
            {
                std::printf ("FAILED -- createEditor returned nothing\n");
                return 1;
            }
        }
        else
        {
            ok ("no editor");
        }

        step ("releaseResources");
        instance->releaseResources();
        ok();

        step ("destroying the instance");
        instance.reset();
        ok();
    }

    std::printf ("\nall checks passed\n");
    return 0;
}
