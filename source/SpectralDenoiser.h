#pragma once

#include <juce_dsp/juce_dsp.h>

#include <memory>
#include <vector>

/** LOST's own noise suppressor, and the only one here that costs nothing to switch on.

    It works in two halves that are deliberately kept apart:

      - An FFT *listens* to the signal and decides how much of each frequency band is
        noise rather than voice. This half is allowed to be slow and careful.

      - A bank of ordinary filters *acts* on the signal, and is not allowed to be slow
        at all: it is a plain cascade of biquads, so a sample walks straight through it.

    That split is the whole point. The obvious way to build a spectral denoiser is to cut
    the audio into overlapping windows, alter each one, and glue them back together --
    but then a sample cannot leave until its whole window has arrived, and the plug-in
    owes the host a window of delay. At 512 samples that is 10.7 ms, which is enough for
    a singer on in-ears to hear themselves twice.

    Here the FFT never touches the audio. It only sets the filters, and it may take as
    long as it likes to do that because the signal is not waiting on it. The suppression
    lands about one frame after the noise changes, which for a noise floor -- the one
    thing on stage that is not in a hurry -- makes no audible difference.

    getLatencySamples() therefore returns 0, and the plug-in is zero latency whether this
    stage is running or not.

    Why this rather than the two things it replaced:

      - Waves NS1 cannot be shipped. Not for licensing reasons -- the file physically
        cannot load on its own. It imports WavesLib1.128_13.0_Win64.dll and fails with
        ERROR_MOD_NOT_FOUND without it, and that library sits inside a ~500 MB plug-in
        tree with several more gigabytes of data behind it.

      - RNNoise is a *speech classifier*. Anything it does not recognise as speech it
        removes outright: a held instrument note, a breath, room tone between words, the
        tail of a sung vowel. Measured, a steady tone came out at -100 dB. That is not a
        noise reduction failure, it is the model doing exactly what it was trained to do
        -- which is the wrong job for a live vocal channel that also has a room in it.

    This estimates the noise floor from the signal itself and attenuates towards it, so
    it has no opinion about what the source *is*. It cannot decide a saxophone is not
    speech and delete it, because it never asks the question.

    The suppression is bounded by construction (see maxReductionDb), so no setting of the
    knob can gate the signal to silence. That bound is the difference between a control a
    singer can use on stage and one that eats their words.
*/
class SpectralDenoiser
{
public:
    SpectralDenoiser();
    ~SpectralDenoiser();

    void prepare (double sampleRate, int maximumBlockSize, int numChannels);
    void reset();

    /** wetAmount 0 leaves the signal untouched; 1 applies the full allowed reduction.

        This scales how deep the suppression goes, rather than mixing a processed copy
        against the original. Mixing would comb-filter: the filters shift phase, so a
        half-and-half blend of filtered and unfiltered would cancel at some frequencies
        and reinforce at others, and the knob would change the tone rather than the
        amount of noise. */
    void process (juce::AudioBuffer<float>& buffer, float wetAmount);

    /** Always zero. The analysis runs beside the signal, not in front of it. */
    int getLatencySamples() const noexcept { return 0; }

private:
    /*  2048 at 48 kHz: a 42.7 ms window, 23.4 Hz per bin.

        Nothing waits on this, so unlike every other spectral denoiser the length is not
        a compromise with delay -- it is chosen purely for how well it hears, and it can
        be as long as it is useful.

        And it needs to be long. Telling a note from noise means seeing the note's
        harmonics as separate peaks, and a bass voice at 110 Hz has them 110 Hz apart. At
        512 that spacing is 1.2 bins, the harmonics blur into a continuum, the voice
        reads as broadband, and it gets suppressed by 19 dB. Measured, going the other
        way: at 1024 a 41 Hz bass note is destroyed at -18 dB because 41 Hz and 50 Hz hum
        share a bin. 2048 separates them and both survive.

        Longer is not better without limit -- 4096 smears consonants and costs 2 dB of
        hiss rejection. This is the measured optimum, not a guess.                     */
    static constexpr int fftOrder = 11;
    static constexpr int fftSize = 1 << fftOrder;       // 2048
    static constexpr int hopSize = fftSize / 4;         // 75% overlap
    static constexpr int numBins = fftSize / 2 + 1;

    /*  Half-octave spacing for the filter bank. Log spacing is the reason this is a bank
        of biquads and not a short FIR: 23 Hz of resolution around 100 Hz would need a
        couple of thousand FIR taps, and one biquad does it.                          */
    static constexpr int maxBands = 24;

    struct Channel;
    std::vector<std::unique_ptr<Channel>> channels;

    std::unique_ptr<juce::dsp::FFT> fft;

    /** Analysis window only. Nothing is resynthesised, so there is no synthesis pair and
        no overlap-add constant to get wrong. */
    std::vector<float> window;

    //==============================================================================
    /** Band centres actually in use -- everything below 0.45 * rate. */
    std::vector<float> bandHz;
    int numBands = 0;

    /*  A cascade of peaking filters is not a set of independent controls: each one leaks
        into its neighbours, so asking all of them for -20 dB gives far more than 20 dB
        where they overlap. This is the map from "what each filter is set to" to "what
        the cascade actually does at each centre", inverted once here so that per frame
        we can go the other way and ask what to set them to. Magnitudes multiply, so in
        decibels it is linear and a matrix is the exact right tool.                    */
    std::vector<float> interactionInverse;   // numBands x numBands, row-major

    double hostRate = 48000.0;
    int maxBlock = 512;

    void buildBands();
    void buildInteractionMatrix();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SpectralDenoiser)
};
