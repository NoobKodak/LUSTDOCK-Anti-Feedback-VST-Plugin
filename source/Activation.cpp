#include "Activation.h"

#include <ActivationPublicKey.h>

namespace
{
/*  Where the request goes. The endpoint is not a secret -- it is in the binary either
    way, and knowing it buys nothing without a key the server agrees was sold.        */
const char* const activationUrl =
    "https://bxopgvnlkauzjctssnfi.supabase.co/functions/v1/activate-licence";

/*  Long enough for a bad hotel connection, short enough that a customer does not think
    the plug-in has hung. The request runs on its own thread, so nothing is blocked
    while this elapses.                                                               */
constexpr int connectTimeoutMs = 12000;

juce::String sha256Hex (const juce::String& text)
{
    const juce::SHA256 hash (text.toRawUTF8(), (size_t) text.getNumBytesAsUTF8());
    return hash.toHexString();
}
}

//==============================================================================
/*  The background half of an activation.

    juce::Thread rather than a lambda on a pool, because the reply has to land back on
    the message thread -- the UI reads the result and the licence state is touched from
    there -- and this keeps the hop explicit.                                        */
class Activation::Request final : public juce::Thread
{
public:
    Request (Activation& ownerIn, juce::String keyIn, std::function<void (Outcome)> callbackIn)
        : juce::Thread ("LOST Duck activation"),
          owner (ownerIn),
          key (std::move (keyIn)),
          callback (std::move (callbackIn))
    {
    }

    ~Request() override { stopThread (connectTimeoutMs + 2000); }

    void run() override
    {
        auto outcome = owner.activateBlocking (key);

        if (threadShouldExit())
            return;

        /*  Hop to the message thread. The callback updates the UI and the licence flag,
            and a WeakReference guards the case where the plug-in was closed while a slow
            request was still running.                                                */
        juce::MessageManager::callAsync (
            [cb = callback, outcome]
            {
                if (cb != nullptr)
                    cb (outcome);
            });
    }

private:
    Activation& owner;
    juce::String key;
    std::function<void (Outcome)> callback;
};

//==============================================================================
Activation::Activation()
{
    refresh();
}

/*  Here rather than in the header: Request is complete at this point, which is what
    lets unique_ptr destroy it. Its own destructor joins the thread, so a plug-in closed
    mid-activation waits for the socket rather than pulling the ground out from under a
    running request.                                                                   */
Activation::~Activation() = default;

juce::PropertiesFile::Options Activation::storeOptions()
{
    juce::PropertiesFile::Options options;
    options.applicationName = "LOST Duck";
    options.filenameSuffix = "settings";
    options.folderName = "Lost Duck";
    options.osxLibrarySubFolder = "Application Support";
    return options;
}

juce::String Activation::machineId()
{
    /*  JUCE hashes a handful of hardware identifiers into this. It is stable across
        reboots and reinstalls of the plug-in, and it does change if the motherboard is
        replaced or, occasionally, after a large Windows update -- which is exactly why
        the server grants a couple of grace re-binds rather than treating a changed
        fingerprint as somebody else's computer.                                      */
    auto id = juce::SystemStats::getUniqueDeviceID();

    if (id.isEmpty())
    {
        // Should not happen, but a machine with no readable id must still be able to
        // activate rather than being locked out by a blank string.
        id = juce::SystemStats::getComputerName() + "|" + juce::SystemStats::getLogonName();
    }

    return id;
}

juce::String Activation::machineName()
{
    auto name = juce::SystemStats::getComputerName();
    return name.isNotEmpty() ? name : juce::String ("Unnamed computer");
}

juce::String Activation::machineHash()
{
    // Must match the server byte for byte, or every token fails to verify.
    return sha256Hex ("lostduck:" + machineId());
}

juce::String Activation::payloadFor (const juce::String& key,
                                     const juce::String& hash,
                                     juce::int64 expires)
{
    return key + "|" + hash + "|" + juce::String (expires);
}

//==============================================================================
void Activation::refresh()
{
    activated = verifyStored();

    if (! activated)
        storedKey = {};
}

bool Activation::verifyStored()
{
    juce::PropertiesFile store (storeOptions());

    const auto key = store.getValue ("activation.key");
    const auto hash = store.getValue ("activation.machine");
    const auto signature = store.getValue ("activation.signature");
    const auto expires = store.getValue ("activation.expires", "0").getLargeIntValue();

    if (key.isEmpty() || hash.isEmpty() || signature.isEmpty())
        return false;

    /*  The token was issued to a machine. Editing the settings file to paste in somebody
        else's token gets you a signature that verifies against *their* hash and not this
        computer's, so the check below is what makes a token non-transferable.        */
    if (hash != machineHash())
        return false;

    if (expires > 0 && juce::Time::currentTimeMillis() / 1000 > expires)
        return false;

    juce::BigInteger sig;
    sig.parseString (signature, 16);

    if (sig.isZero())
        return false;

    const juce::RSAKey publicKey { LOSTDUCK_ACTIVATION_PUBLIC_KEY };

    // value^e mod n, recovering the digest the server signed.
    publicKey.applyToValue (sig);

    juce::BigInteger expected;
    expected.parseString (sha256Hex (payloadFor (key, hash, expires)), 16);

    if (sig != expected)
        return false;

    storedKey = key;
    return true;
}

//==============================================================================
Activation::Outcome Activation::activateBlocking (const juce::String& key)
{
    const auto trimmed = key.trim();

    if (trimmed.isEmpty())
        return { false, "Type your licence key first.", false };

    juce::DynamicObject::Ptr body { new juce::DynamicObject() };
    body->setProperty ("key", trimmed);
    body->setProperty ("machine", machineId());
    body->setProperty ("machine_name", machineName());

    const auto request = juce::URL (activationUrl)
        .withPOSTData (juce::JSON::toString (juce::var { body.get() }));

    int status = 0;

    auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
        .withExtraHeaders ("Content-Type: application/json")
        .withConnectionTimeoutMs (connectTimeoutMs)
        .withStatusCode (&status);

    auto stream = request.createInputStream (options);

    if (stream == nullptr)
    {
        /*  No connection at all. Told apart from a rejected key on purpose: the customer
            needs to know this is their internet and not their purchase.              */
        return { false,
                 "Could not reach the activation server. Check your internet connection "
                 "and try again -- the plug-in keeps working in demo mode meanwhile.",
                 true };
    }

    const auto reply = stream->readEntireStreamAsString();
    const auto parsed = juce::JSON::parse (reply);

    if (! parsed.isObject())
        return { false, "The activation server sent something unreadable. Try again shortly.", true };

    if (! (bool) parsed.getProperty ("ok", false))
    {
        const auto message = parsed.getProperty ("error", juce::var()).toString();

        return { false,
                 message.isNotEmpty() ? message
                                      : juce::String ("That key could not be activated."),
                 status == 0 };
    }

    const auto issuedKey = parsed.getProperty ("key", juce::var()).toString();
    const auto hash = parsed.getProperty ("machine_hash", juce::var()).toString();
    const auto signature = parsed.getProperty ("signature", juce::var()).toString();
    const auto expires = (juce::int64) parsed.getProperty ("expires", juce::var (0));

    if (issuedKey.isEmpty() || hash.isEmpty() || signature.isEmpty())
        return { false, "The activation server sent an incomplete reply. Try again shortly.", true };

    /*  The reply is not trusted on its face. It is written, then verified through exactly
        the same path used at every startup -- so a token that would fail tomorrow fails
        now, while the customer is still looking at the screen and can be told.       */
    {
        juce::PropertiesFile store (storeOptions());
        store.setValue ("activation.key", issuedKey);
        store.setValue ("activation.machine", hash);
        store.setValue ("activation.signature", signature);
        store.setValue ("activation.expires", juce::String (expires));
        store.saveIfNeeded();
    }

    if (! verifyStored())
    {
        deactivate();
        return { false,
                 "Activation was refused by this copy of the plug-in. If this keeps "
                 "happening, contact support with your order number.",
                 false };
    }

    activated = true;
    return { true, "Activated. This computer is now licensed.", false };
}

void Activation::activateAsync (const juce::String& key, std::function<void (Outcome)> whenDone)
{
    // One at a time. A customer hammering the button should not open four sockets.
    inFlight = std::make_unique<Request> (*this, key, std::move (whenDone));
    inFlight->startThread();
}

void Activation::deactivate()
{
    storedKey = {};
    activated = false;

    juce::PropertiesFile store (storeOptions());
    store.removeValue ("activation.key");
    store.removeValue ("activation.machine");
    store.removeValue ("activation.signature");
    store.removeValue ("activation.expires");
    store.saveIfNeeded();
}
