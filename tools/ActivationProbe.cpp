/*  Drives the real Activation class against the real server.

    Written because "it compiles" says nothing about whether a customer can activate. The
    interesting failures all live between the plug-in and the service -- a machine hash
    the two sides compute differently, a signature format juce::RSAKey will not parse, a
    token that verifies today and not after a restart. None of those show up in a build
    log, and finding them from inside a DAW means a rebuild per attempt.

    This exercises the same code the plug-in runs, in a console app, so each case takes a
    second instead of a reinstall.

    Build:  cmake --build --preset vs --config Release --target LostDuckActivationProbe
    Usage:  LostDuckActivationProbe <licence-key> [--async]

    --async routes the request through activateAsync, on a background thread with the
    result delivered back to the message thread, which is exactly what the plug-in does.
    Added after an activation failed inside the plug-in while succeeding here: no request
    reached the server at all, so the background thread was the one structural difference
    between the two that could still be tested from a console.
*/

#include "../source/Activation.h"

#include <juce_core/juce_core.h>

#include <cstdio>

namespace
{
void line (const char* label, const juce::String& value)
{
    std::printf ("  %-22s %s\n", label, value.toRawUTF8());
}
}

int main (int argc, char** argv)
{
    const juce::ScopedJuceInitialiser_GUI juceInit;

    std::printf ("LOST Duck -- activation probe\n\n");

    Activation activation;

    std::printf ("this machine\n");
    line ("id", Activation::machineId());
    line ("name", Activation::machineName());
    line ("already activated", activation.isActivated() ? "yes" : "no");

    if (argc < 2)
    {
        std::printf ("\nPass a licence key to attempt an activation.\n");
        return 0;
    }

    const juce::String key { argv[1] };

    bool async = false;

    for (int i = 2; i < argc; ++i)
        if (juce::String (argv[i]) == "--async")
            async = true;

    std::printf ("\nactivating %s  (%s)\n", key.toRawUTF8(),
                 async ? "background thread, as the plug-in does" : "this thread");

    Activation::Outcome outcome;

    if (async)
    {
        /*  Pumping the message loop by hand rather than running a JUCEApplication: the
            result is posted with callAsync, so something has to dispatch it, and this
            keeps the probe a plain console program.                                  */
        bool done = false;

        activation.activateAsync (key, [&outcome, &done] (Activation::Outcome result)
        {
            outcome = std::move (result);
            done = true;
        });

        const auto deadline = juce::Time::getMillisecondCounter() + 60000;

        while (! done && juce::Time::getMillisecondCounter() < deadline)
            juce::MessageManager::getInstance()->runDispatchLoopUntil (50);

        if (! done)
        {
            std::printf ("  timed out waiting for the background request\n");
            return 1;
        }
    }
    else
    {
        outcome = activation.activateBlocking (key);
    }

    line ("ok", outcome.ok ? "yes" : "no");
    line ("offline", outcome.offline ? "yes" : "no");
    line ("message", outcome.message);

    if (! outcome.ok)
        return 1;

    /*  The part that matters most: a token that verifies once but not after a restart is
        worse than one that never worked, because it fails at a gig rather than at the
        desk. A second Activation reads the stored token from disk exactly as a fresh
        launch would.                                                                  */
    std::printf ("\nre-reading from disk, as a fresh launch would\n");

    Activation reloaded;
    line ("verifies offline", reloaded.isActivated() ? "yes" : "NO -- token did not survive");

    return reloaded.isActivated() ? 0 : 1;
}
