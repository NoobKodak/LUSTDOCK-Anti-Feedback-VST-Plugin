#include "Licence.h"

#include <LicenceSecret.h>

#include <juce_cryptography/juce_cryptography.h>

namespace
{
/** Crockford base32: no I, L, O or U, so nothing on the sheet can be mistyped as
    something else that is also valid. */
const char* const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

constexpr int serialBytes = 3;    // 24 bits
constexpr int tagBytes = 7;       // 56 bits
constexpr int payloadBytes = serialBytes + tagBytes;   // 10 bytes -> 16 base32 chars

int valueOfChar (juce::juce_wchar c)
{
    const auto upper = juce::CharacterFunctions::toUpperCase (c);

    // Crockford treats these as the same glyph. Accepting them costs nothing and saves
    // a support email every time somebody reads a key off a phone.
    if (upper == 'I' || upper == 'L') return 1;
    if (upper == 'O') return 0;
    if (upper == 'U') return -1;   // deliberately not aliased: too close to V

    for (int i = 0; i < 32; ++i)
        if (alphabet[i] == (char) upper)
            return i;

    return -1;
}

/** HMAC-SHA256. JUCE ships SHA256 but not HMAC, and a bare hash of secret||message is
    vulnerable to length extension, so this is the real construction. */
juce::MemoryBlock hmacSha256 (const juce::MemoryBlock& key, const juce::MemoryBlock& message)
{
    constexpr int blockSize = 64;

    juce::MemoryBlock paddedKey (blockSize, true);

    if (key.getSize() > (size_t) blockSize)
    {
        const auto hashed = juce::SHA256 (key.getData(), key.getSize()).getRawData();
        paddedKey.copyFrom (hashed.getData(), 0, hashed.getSize());
    }
    else
    {
        paddedKey.copyFrom (key.getData(), 0, key.getSize());
    }

    juce::MemoryBlock inner (blockSize, false), outer (blockSize, false);

    for (int i = 0; i < blockSize; ++i)
    {
        const auto byte = static_cast<juce::uint8> (paddedKey[i]);
        inner[i] = static_cast<char> (byte ^ 0x36);
        outer[i] = static_cast<char> (byte ^ 0x5c);
    }

    inner.append (message.getData(), message.getSize());
    const auto innerHash = juce::SHA256 (inner.getData(), inner.getSize()).getRawData();

    outer.append (innerHash.getData(), innerHash.getSize());
    return juce::SHA256 (outer.getData(), outer.getSize()).getRawData();
}

juce::MemoryBlock secretKey()
{
    const juce::String hex { LOSTDUCK_LICENCE_SECRET };
    const auto count = hex.length() / 2;

    juce::MemoryBlock bytes ((size_t) count, true);

    for (int i = 0; i < count; ++i)
        bytes[i] = static_cast<char> (hex.substring (i * 2, i * 2 + 2).getHexValue32());

    return bytes;
}

/** 10 bytes in, 16 base32 characters out. */
juce::String encode (const juce::uint8* data)
{
    juce::String out;
    juce::uint32 buffer = 0;
    int bitsHeld = 0;

    for (int i = 0; i < payloadBytes; ++i)
    {
        buffer = (buffer << 8) | data[i];
        bitsHeld += 8;

        while (bitsHeld >= 5)
        {
            bitsHeld -= 5;
            out << alphabet[(buffer >> bitsHeld) & 0x1f];
        }
    }

    return out;
}

/** The inverse. Expects exactly 16 already-normalised characters. */
bool decode (const juce::String& key, juce::uint8* out)
{
    juce::uint32 buffer = 0;
    int bitsHeld = 0;
    int written = 0;

    for (int i = 0; i < key.length(); ++i)
    {
        const auto value = valueOfChar (key[i]);

        if (value < 0)
            return false;

        buffer = (buffer << 5) | (juce::uint32) value;
        bitsHeld += 5;

        if (bitsHeld >= 8)
        {
            bitsHeld -= 8;

            if (written >= payloadBytes)
                return false;

            out[written++] = static_cast<juce::uint8> ((buffer >> bitsHeld) & 0xff);
        }
    }

    return written == payloadBytes;
}
}

//==============================================================================
juce::String Licence::normalise (const juce::String& typedKey)
{
    juce::String cleaned;

    for (int i = 0; i < typedKey.length(); ++i)
    {
        const auto c = typedKey[i];

        if (juce::CharacterFunctions::isWhitespace (c) || c == '-' || c == '_')
            continue;

        if (valueOfChar (c) < 0)
            return {};

        cleaned << juce::CharacterFunctions::toUpperCase (c);
    }

    return cleaned.length() == keyLength ? cleaned : juce::String();
}

juce::String Licence::format (const juce::String& normalisedKey)
{
    juce::StringArray groups;

    for (int i = 0; i < normalisedKey.length(); i += groupLength)
        groups.add (normalisedKey.substring (i, i + groupLength));

    return groups.joinIntoString ("-");
}

bool Licence::verify (const juce::String& typedKey)
{
    const auto key = normalise (typedKey);

    if (key.isEmpty())
        return false;

    juce::uint8 payload[payloadBytes] = {};

    if (! decode (key, payload))
        return false;

    juce::MemoryBlock serial (payload, serialBytes);
    const auto expected = hmacSha256 (secretKey(), serial);

    if (expected.getSize() < (size_t) tagBytes)
        return false;

    // Constant time: bailing early on the first wrong byte leaks how much of a guess
    // was right, which is the whole basis of a timing attack on a tag comparison.
    juce::uint8 difference = 0;

    for (int i = 0; i < tagBytes; ++i)
        difference |= static_cast<juce::uint8> (payload[serialBytes + i] ^ static_cast<juce::uint8> (expected[i]));

    return difference == 0;
}

juce::String Licence::create (juce::uint32 serial)
{
    juce::uint8 payload[payloadBytes] = {};

    payload[0] = static_cast<juce::uint8> ((serial >> 16) & 0xff);
    payload[1] = static_cast<juce::uint8> ((serial >> 8) & 0xff);
    payload[2] = static_cast<juce::uint8> (serial & 0xff);

    juce::MemoryBlock serialBlock (payload, serialBytes);
    const auto tag = hmacSha256 (secretKey(), serialBlock);

    for (int i = 0; i < tagBytes; ++i)
        payload[serialBytes + i] = static_cast<juce::uint8> (tag[i]);

    return format (encode (payload));
}

//==============================================================================
juce::PropertiesFile::Options Licence::storeOptions()
{
    juce::PropertiesFile::Options options;
    options.applicationName = "LOST Duck";
    options.filenameSuffix = "settings";
    options.folderName = "Lost Duck";
    options.osxLibrarySubFolder = "Application Support";
    return options;
}

Licence::Licence()
{
    refresh();
}

void Licence::refresh()
{
    juce::PropertiesFile store (storeOptions());
    storedKey = store.getValue ("key");

    // Verified every time rather than trusting a stored "activated" flag, so editing
    // the settings file by hand achieves nothing.
    activated = verify (storedKey);

    if (! activated)
        storedKey = {};
}

bool Licence::activate (const juce::String& typedKey)
{
    if (! verify (typedKey))
        return false;

    storedKey = format (normalise (typedKey));
    activated = true;

    juce::PropertiesFile store (storeOptions());
    store.setValue ("key", storedKey);
    store.saveIfNeeded();
    return true;
}

void Licence::deactivate()
{
    storedKey = {};
    activated = false;

    juce::PropertiesFile store (storeOptions());
    store.removeValue ("key");
    store.saveIfNeeded();
}
