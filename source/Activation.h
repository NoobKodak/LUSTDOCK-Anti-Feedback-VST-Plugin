#pragma once

#include <juce_core/juce_core.h>
#include <juce_cryptography/juce_cryptography.h>
#include <juce_data_structures/juce_data_structures.h>

#include <functional>

/** Online activation, offline afterwards.

    The plug-in asks the server once, over the internet, whether a key may run on this
    machine. The server answers with a token signed by a key only it holds. From then on
    the plug-in verifies that token by itself, forever, with no network.

    Why the change from the old scheme: the previous licence signed keys with an HMAC
    secret that was *compiled into the shipped binary*. Extract it and you have a key
    generator for every key that will ever be sold, and there is no way to rotate it
    without invalidating every key already issued. Here the plug-in carries only a public
    key. Reading it out of the binary tells an attacker nothing they can use.

    The token binds a key to one machine, which is what makes seats mean anything -- a
    key posted on a forum activates on the buyer's machines and nowhere else.

    Deliberately not done: a check on every launch. This is a live performance tool. A
    stage laptop that has not seen the internet since March must still open the plug-in,
    so once activated it never asks again.
*/
class Activation
{
public:
    Activation();

    /*  Declared here and defined in the .cpp on purpose. `inFlight` is a unique_ptr to
        Request, which is only completed in the .cpp, and an implicit destructor would be
        instantiated in every translation unit that includes this header -- where Request
        is still incomplete and cannot be deleted.                                     */
    ~Activation();

    /** True when a valid token for *this* machine is stored. Offline, cheap, and safe to
        call from anywhere -- it is what the plug-in checks at startup. */
    bool isActivated() const noexcept { return activated; }

    /** What the shop calls this computer, so "release a seat" is a choice between names
        rather than between hex strings. */
    static juce::String machineName();

    /** Stable per-machine identifier. Sent raw; the server stores only a hash of it. */
    static juce::String machineId();

    struct Outcome
    {
        bool ok = false;
        /** Shown to the customer verbatim, so it has to read like a sentence a musician
            would understand rather than a status code. */
        juce::String message;
        /** True when the failure was the network rather than the key, which is worth
            distinguishing: one is "try again later", the other is "check what you typed". */
        bool offline = false;
    };

    /*  Talks to the server. Blocks, so it must never be called from the audio thread or
        the message thread -- see activateAsync, which is what everything actually uses. */
    Outcome activateBlocking (const juce::String& key);

    /** Runs the request on a background thread and delivers the result on the message
        thread. The UI stays responsive while a slow connection is timing out. */
    void activateAsync (const juce::String& key, std::function<void (Outcome)> whenDone);

    /** Forgets the token on this machine. Does not release the seat server-side -- that
        is done from the shop, because a machine that has died cannot ask for anything. */
    void deactivate();

    /** Re-reads and re-verifies from disk. */
    void refresh();

private:
    static juce::PropertiesFile::Options storeOptions();

    /** sha256("lostduck:" + machineId()), matching what the server stores. */
    static juce::String machineHash();

    /** The exact string the signature covers: key|machineHash|expiry. */
    static juce::String payloadFor (const juce::String& key,
                                    const juce::String& hash,
                                    juce::int64 expires);

    bool verifyStored();

    juce::String storedKey;
    bool activated = false;

    /*  Kept alive for the lifetime of the plug-in so an activation that is still in
        flight when a window closes does not run into a freed object. */
    class Request;
    std::unique_ptr<Request> inFlight;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Activation)
};
