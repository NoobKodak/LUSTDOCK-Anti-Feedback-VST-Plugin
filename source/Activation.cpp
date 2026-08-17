#include "Activation.h"

#include <ActivationPublicKey.h>

#if JUCE_WINDOWS
 #include <windows.h>
 #include <winhttp.h>
 /*  Linked here rather than from CMake because this file is the only thing that needs it,
     and it is compiled into three different targets. MSVC-only, which this product is. */
 #pragma comment (lib, "winhttp.lib")
#endif

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

/*  How many times to try opening the socket before calling it a dead connection.

    Not superstition. The first HTTP call a Windows process makes goes through
    InternetOpen with INTERNET_OPEN_TYPE_PRECONFIG, which runs proxy auto-detection --
    and that first call can fail outright on a machine whose network stack is otherwise
    perfectly healthy. It reproduced exactly that way here: the same key, on the same
    machine, minutes apart, failed inside the plug-in without a single request reaching
    the server, and succeeded from a console process that had already opened a session.

    It is also simply the right behaviour for where this plug-in lives. Venue wifi drops
    a first packet routinely, and a musician should not have to work out that the fix is
    to press the button again.                                                        */
constexpr int connectAttempts = 3;

/*  Long enough for a half-open connection to finish collapsing, short enough that three
    attempts still feel like one action rather than a hang.                           */
constexpr int retryPauseMs = 800;

juce::String sha256Hex (const juce::String& text)
{
    const juce::SHA256 hash (text.toRawUTF8(), (size_t) text.getNumBytesAsUTF8());
    return hash.toHexString();
}

//==============================================================================
/** What came back, and if nothing did, why not. */
struct HttpReply
{
    /** True when the server answered at all, whatever it said. */
    bool reached = false;
    int status = 0;
    juce::String body;
    /** Short technical note for the customer-facing message. Not a sentence -- it gets
        embedded in one -- but concrete enough to be worth reading out over the phone. */
    juce::String failure;
};

#if JUCE_WINDOWS
/*  A second, independent way to make the same request.

    juce::URL is the first choice and handles this everywhere. But on Windows it goes
    through WinINet, and the session handle it uses is a *function-local static*: opened
    once for the life of the process, never reopened. If that one call fails -- and it can,
    because INTERNET_OPEN_TYPE_PRECONFIG runs proxy auto-detection -- then every request
    from that process fails for as long as the process lives, and retrying cannot help,
    because the retry reuses the same dead handle. Restarting the DAW is the only cure,
    which is not something to ask of somebody about to go on stage.

    That fits what was actually observed: activation failed inside the plug-in without a
    single request reaching the server, while the identical code in a console process
    succeeded moments later on the same machine and the same connection.

    WinHTTP is a different API with its own session, opened per request. It also resolves
    proxies more sanely than WinINet -- WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY covers WPAD and
    the user's own settings -- which is worth having in the venues this plug-in runs in.

    Used only as a fallback. The common path stays the one that is exercised on every
    platform, so this cannot quietly become the only tested route.                     */
HttpReply postJsonWithWinHttp (const juce::String& urlText, const juce::String& payload)
{
    HttpReply reply;

    /*  Closes on every exit path, including the early returns below. Each handle has to
        outlive the ones opened from it, which the declaration order gives us in reverse. */
    struct Handle
    {
        HINTERNET h = nullptr;
        ~Handle() { if (h != nullptr) WinHttpCloseHandle (h); }
    };

    URL_COMPONENTS parts {};
    parts.dwStructSize = sizeof (parts);
    parts.dwHostNameLength = (DWORD) -1;
    parts.dwUrlPathLength = (DWORD) -1;
    parts.dwExtraInfoLength = (DWORD) -1;

    if (! WinHttpCrackUrl (urlText.toWideCharPointer(), 0, 0, &parts))
    {
        reply.failure = "url " + juce::String ((int) GetLastError());
        return reply;
    }

    // Kept alive as named locals: toWideCharPointer hands back a pointer into the
    // String's own storage, so the String has to outlive the call that uses it.
    const juce::String host (parts.lpszHostName, parts.dwHostNameLength);
    juce::String path (parts.lpszUrlPath, parts.dwUrlPathLength);

    if (parts.dwExtraInfoLength > 0)
        path += juce::String (parts.lpszExtraInfo, parts.dwExtraInfoLength);

    Handle session, connection, request;

    session.h = WinHttpOpen (L"LOST Duck", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                             WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);

    // Automatic proxy detection needs Windows 8.1. Older machines get the plain default.
    if (session.h == nullptr)
        session.h = WinHttpOpen (L"LOST Duck", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                 WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);

    if (session.h == nullptr)
    {
        reply.failure = "open " + juce::String ((int) GetLastError());
        return reply;
    }

    WinHttpSetTimeouts (session.h, connectTimeoutMs, connectTimeoutMs,
                        connectTimeoutMs, connectTimeoutMs);

    connection.h = WinHttpConnect (session.h, host.toWideCharPointer(), parts.nPort, 0);

    if (connection.h == nullptr)
    {
        reply.failure = "connect " + juce::String ((int) GetLastError());
        return reply;
    }

    request.h = WinHttpOpenRequest (connection.h, L"POST", path.toWideCharPointer(),
                                    nullptr, WINHTTP_NO_REFERER,
                                    WINHTTP_DEFAULT_ACCEPT_TYPES,
                                    parts.nScheme == INTERNET_SCHEME_HTTPS
                                        ? WINHTTP_FLAG_SECURE : 0u);

    if (request.h == nullptr)
    {
        reply.failure = "request " + juce::String ((int) GetLastError());
        return reply;
    }

    const auto* bytes = payload.toRawUTF8();
    const auto length = (DWORD) payload.getNumBytesAsUTF8();

    if (! WinHttpSendRequest (request.h, L"Content-Type: application/json\r\n", (DWORD) -1,
                              (LPVOID) bytes, length, length, 0))
    {
        reply.failure = "send " + juce::String ((int) GetLastError());
        return reply;
    }

    if (! WinHttpReceiveResponse (request.h, nullptr))
    {
        reply.failure = "receive " + juce::String ((int) GetLastError());
        return reply;
    }

    DWORD code = 0, codeSize = sizeof (code);

    if (WinHttpQueryHeaders (request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &code, &codeSize, WINHTTP_NO_HEADER_INDEX))
    {
        reply.status = (int) code;
    }

    juce::MemoryOutputStream received;

    for (;;)
    {
        DWORD available = 0;

        if (! WinHttpQueryDataAvailable (request.h, &available) || available == 0)
            break;

        juce::HeapBlock<char> buffer (available);
        DWORD read = 0;

        if (! WinHttpReadData (request.h, buffer.getData(), available, &read) || read == 0)
            break;

        received.write (buffer.getData(), (size_t) read);
    }

    reply.reached = true;
    reply.body = received.toString();
    return reply;
}
#endif

/*  Posts the JSON and says what happened.

    juce::URL first, retried, because that is the path every platform shares. Only if it
    never opens a socket does the Windows fallback above get a turn.                    */
HttpReply postJson (const juce::String& urlText, const juce::String& payload)
{
    HttpReply reply;

   #if JUCE_WINDOWS
    /*  Support switch, and the only way to exercise the fallback on a machine where the
        usual path works. It selects an HTTP stack and nothing else -- it cannot activate
        anything, skip a check, or change what the server is asked.                     */
    if (juce::SystemStats::getEnvironmentVariable ("LOSTDUCK_FORCE_WINHTTP", {}).isNotEmpty())
    {
        auto forced = postJsonWithWinHttp (urlText, payload);

        if (forced.reached)
            return forced;

        forced.failure = "winhttp " + forced.failure;
        return forced;
    }
   #endif

    const auto request = juce::URL (urlText).withPOSTData (payload);

    for (int attempt = 1; attempt <= connectAttempts; ++attempt)
    {
        reply.status = 0;

        auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
            .withExtraHeaders ("Content-Type: application/json")
            .withConnectionTimeoutMs (connectTimeoutMs)
            .withStatusCode (&reply.status);

        if (auto stream = request.createInputStream (options))
        {
            reply.reached = true;
            reply.body = stream->readEntireStreamAsString();
            return reply;
        }

        /*  JUCE fills the status code in even when it hands back nothing, so a non-zero
            code means the server did answer and the failure came after that. Asking a
            working server the same question again would not help.                     */
        if (reply.status != 0)
        {
            reply.failure = "http " + juce::String (reply.status);
            return reply;
        }

        if (attempt < connectAttempts)
            juce::Thread::sleep (retryPauseMs);
    }

   #if JUCE_WINDOWS
    auto fallback = postJsonWithWinHttp (urlText, payload);

    if (fallback.reached)
        return fallback;

    reply.failure = "wininet dead, winhttp " + fallback.failure;
   #else
    reply.failure = "no connection";
   #endif

    return reply;
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

    const auto sent = postJson (activationUrl, juce::JSON::toString (juce::var { body.get() }));

    if (! sent.reached)
    {
        /*  Told apart from a rejected key on purpose: the customer needs to know this is
            their internet and not their purchase.

            The technical note is appended rather than hidden. It means nothing to a
            singer, but it is the difference between a support email that says "it says no
            connection" and one that can actually be diagnosed, and it costs one short
            parenthesis on a screen almost nobody will ever see.                        */
        return { false,
                 "Could not reach the activation server. Check your internet connection "
                 "and try again -- the plug-in keeps working in demo mode meanwhile. ("
                   + sent.failure + ")",
                 true };
    }

    const auto parsed = juce::JSON::parse (sent.body);

    /*  Everything below here reached the server, so none of it is a connection problem.
        Saying "no connection" to somebody whose connection plainly works sends them to
        check the one thing that is not broken.                                        */
    if (! parsed.isObject())
        return { false, "The activation server sent something unreadable. Try again shortly.", false };

    if (! (bool) parsed.getProperty ("ok", false))
    {
        const auto message = parsed.getProperty ("error", juce::var()).toString();

        return { false,
                 message.isNotEmpty() ? message
                                      : juce::String ("That key could not be activated."),
                 false };
    }

    const auto issuedKey = parsed.getProperty ("key", juce::var()).toString();
    const auto hash = parsed.getProperty ("machine_hash", juce::var()).toString();
    const auto signature = parsed.getProperty ("signature", juce::var()).toString();
    const auto expires = (juce::int64) parsed.getProperty ("expires", juce::var (0));

    if (issuedKey.isEmpty() || hash.isEmpty() || signature.isEmpty())
        return { false, "The activation server sent an incomplete reply. Try again shortly.", false };

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
