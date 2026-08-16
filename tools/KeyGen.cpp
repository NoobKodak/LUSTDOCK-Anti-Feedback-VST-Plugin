/*  Licence key generator.

    Mints keys for LOST Duck using the same secret and the same verifier the plug-in
    uses -- Licence.cpp is compiled straight into this tool rather than reimplemented,
    because a generator that disagrees with the verifier is worse than no generator.

    Usage:
        LostDuckKeyGen                 one key from a random serial
        LostDuckKeyGen 500             five hundred keys, as CSV on stdout
        LostDuckKeyGen check KEY       verify a key

    Build:  cmake --preset vs -DLOSTDUCK_BUILD_HARNESS=ON
            cmake --build --preset vs --config Release --target LostDuckKeyGen

    Redirect to a file and upload that to your store:
        LostDuckKeyGen 5000 > keys.csv

    Serials are drawn at random from 24 bits, so a batch can repeat one. That is
    harmless -- a duplicate serial produces a duplicate key, and the store hands each
    row out once -- but if you want them strictly unique, sort and de-duplicate the CSV.
*/

#include "../source/Licence.h"

#include <cstdio>
#include <cstdlib>

int main (int argc, char** argv)
{
    juce::Random random (juce::Time::getHighResolutionTicks());

    if (argc >= 3 && juce::String (argv[1]).equalsIgnoreCase ("check"))
    {
        const juce::String key { argv[2] };
        const auto ok = Licence::verify (key);

        std::printf ("%s  %s\n", Licence::format (Licence::normalise (key)).toRawUTF8(),
                     ok ? "VALID" : "NOT VALID");
        return ok ? 0 : 1;
    }

    const auto count = argc >= 2 ? juce::jmax (1, std::atoi (argv[1])) : 1;

    if (count > 1)
        std::printf ("serial,key\n");

    for (int i = 0; i < count; ++i)
    {
        const auto serial = static_cast<juce::uint32> (random.nextInt (0x1000000));
        const auto key = Licence::create (serial);

        if (count > 1)
            std::printf ("%u,%s\n", serial, key.toRawUTF8());
        else
            std::printf ("%s\n", key.toRawUTF8());
    }

    return 0;
}
