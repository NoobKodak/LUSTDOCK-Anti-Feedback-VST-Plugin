#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>   // PropertiesFile

/** Offline activation.

    A key is 16 characters, shown in four groups of four:

        XXXX-XXXX-XXXX-XXXX

    Crockford base32, so there is no I, L, O or U to be confused with 1, 0 or V when
    somebody types a key off a phone screen. Sixteen characters is 80 bits: a 24-bit
    serial and a 56-bit HMAC-SHA256 tag over that serial, keyed with a secret compiled
    into the plug-in.

    The plug-in holds no list of valid keys. It recomputes the tag and compares, so a
    key minted years after this build shipped still activates it, and `strings` on the
    binary yields nothing useful.

    What this stops: guessing (one in 2^56), and shipping a build that has to be updated
    for every sale. What it does not stop: somebody who reverse-engineers the secret out
    of the binary and writes a key generator, or who patches the check out entirely.
    Every client-side licence check has that ceiling; the point is to make casual
    copying inconvenient, not to be unbreakable.
*/
class Licence
{
public:
    Licence();

    /** Re-checks the stored key. Called on construction; a hand-edited settings file
        does not survive it. */
    void refresh();

    bool isActivated() const noexcept { return activated; }

    /** Validates and, if good, stores the key. Returns false and changes nothing
        otherwise. Accepts any spacing, dashes or case. */
    bool activate (const juce::String& typedKey);

    /** Forgets the stored key. Only used for testing the demo path. */
    void deactivate();

    juce::String getStoredKey() const { return storedKey; }

    //==============================================================================
    /** True when the key is well formed and its tag matches. Static so the key
        generator can use exactly the same check the plug-in does -- a generator that
        disagrees with the verifier is worse than no generator. */
    static bool verify (const juce::String& typedKey);

    /** Builds a key for a serial in 0 .. 0xFFFFFF. Used by the generator tool. */
    static juce::String create (juce::uint32 serial);

    /** Strips spacing and dashes, uppercases, and maps the characters Crockford treats
        as interchangeable. Returns an empty string if the result is not 16 valid
        characters. */
    static juce::String normalise (const juce::String& typedKey);

    /** "XXXX-XXXX-XXXX-XXXX" for display. */
    static juce::String format (const juce::String& normalisedKey);

    static constexpr int keyLength = 16;
    static constexpr int groupLength = 4;

private:
    static juce::PropertiesFile::Options storeOptions();

    juce::String storedKey;
    bool activated = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Licence)
};
