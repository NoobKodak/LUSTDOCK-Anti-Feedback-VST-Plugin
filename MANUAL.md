# LOST DUCK Anti Feedback

**Version 1.0** — LOST · developed by noobkodak

A feedback suppressor for live vocals. It listens for the frequencies that are about to
howl and pulls them down, while leaving the voice alone.

---

## Installing

**VST3** — copy `LOST DUCK Anti Feedback.vst3` into:

```
C:\Program Files\Common Files\VST3
```

Restart your host, or rescan plugins. It appears as **LOST DUCK Anti Feedback** by
**LOST**.

**Standalone** — run `LOST DUCK Anti Feedback.exe`. No host needed. Choose your mic and
outputs under **Options → Audio/MIDI Settings**.

**Requirements:** Windows 10 or 11, 64-bit. Any VST3 host.

---

## Activation

Unlicensed, the plugin runs in demo mode: audio plays for 15 seconds, then mutes for 10,
repeating. A **DEMO** badge sits in the top-right of the screen.

1. Click the **DEMO** badge.
2. Type your activation key into the boxes. It looks like `XXXX-XXXX-XXXX-XXXX`.
3. The badge disappears and audio stays up.

You can paste a whole key at once. Dashes, spaces and lower case are all fine. There is
no I, L, O or U in a key — if you see something that looks like a letter O it is a zero,
and a letter I is a one.

Activation is stored per machine and survives restarts. It works offline; the plugin
never contacts a server, so it activates the same at a venue with no wifi.

---

## Where to put it in the chain

Put it on the **vocal channel**, after your gate and EQ, before the compressor and any
reverb. It should see the voice, not the effects.

Do not put it on the master bus. It works by notching narrow bands, and on a full mix
those notches land on music as well as on the howl.

---

## The controls

### Power

The orange button. Bypasses everything when off, including the noise reduction. Existing
notches are cleared, so turning it back on starts from a clean slate.

Clicking it makes a soft click sound — that's deliberate feedback that the switch
registered, not a click in your audio.

### Notch limit

The number on the left of the screen. Click it, then scroll to choose **1 to 16**.

This is how many frequencies the plugin is allowed to hold down at once.

| Setting | Use for |
|---|---|
| **1–4** | Studio, quiet stage, one wedge. Least effect on tone. |
| **5–8** | Normal live use. This is the default range and where most people should sit. |
| **9–16** | Difficult rooms, high stage volume, mic in front of the PA. |

**More is not better.** Each notch removes a narrow slice of the voice. Sixteen notches
in a well-behaved room will thin the vocal for no benefit. Start at 6 and only raise it
if you still get feedback.

Lowering the limit mid-show is safe — extra notches are retired immediately.

### Shift

Shifts the whole signal up by a fraction of a Hz, up to 12 Hz.

Feedback happens when a sound goes round the loop — mic, PA, room, mic — and comes back
in phase with itself. Moving the frequency slightly each time round means it never lines
up, so the loop cannot build. This buys real gain before feedback and costs nothing on
its own.

**5 Hz is the default and suits almost everything.** Higher settings buy a little more
headroom and start to sound faintly odd on sustained notes. Below about 3 Hz the
preventative effect drops off sharply.

The plugin raises the shift by itself when it senses trouble and lowers it again when
things are calm, so the number you set is a ceiling rather than a constant.

### Noise switch and knob

The switch turns noise reduction on and off, and **starts off**. The knob sets how much,
0 to 100%, and shows the percentage on screen as you turn it. When the switch is off the
knob does nothing.

This removes steady **broadband** background noise — air conditioning, stage hiss, preamp
hiss, low rumble — from the vocal. It does not remove feedback; that is the rest of the
plugin's job.

Two things it deliberately does *not* do:

- **It leaves sustained notes alone.** A held vowel, an organ pad or a bowed note stays
  where it is however long it is held. Noise reducers that work by learning "whatever
  does not change is noise" eat those notes; this one tells a note from a hiss by its
  shape, not by how long it lasts. Measured, a held tone costs 0.3 dB while hiss around
  it comes down 17.6 dB.

- **It does not remove mains hum.** Hum is a narrow, steady tone, and so is a note — the
  only setting that would take out the hum would also take out the note. Use the notch
  bank for hum, or fix the earth loop at the desk.

**It adds no latency.** Nothing in this plugin does, with the noise switch on or off, and
that is checked on every build rather than assumed. Most noise reduction works by chopping
the audio into windows and gluing it back together, which means a sample cannot leave
until its whole window has arrived — usually 5 to 20 ms. This one analyses the signal off
to the side and uses the answer to set a bank of ordinary filters, so audio walks straight
through. You can monitor through it on wired in-ears.

The knob runs from no reduction up to **20 dB** of reduction, and cannot silence anything
however far you turn it. 50% is plenty for most stages.

---

## Reading the screen

The waveform shows what is coming out. When the plugin places a notch you will see the
level dip briefly.

The **DEMO** badge appears top-right until you activate.

---

## Setting it up at a gig

1. Power on, notch limit **6**, shift **5 Hz**, noise off.
2. Ring the system out the way you normally would: raise the vocal fader slowly until it
   just starts to ring, then back off slightly. The plugin will catch the ring and place
   notches as you go.
3. If it still rings at that level, raise the notch limit two at a time.
4. If the voice sounds thin, lower the notch limit.
5. Only turn on noise reduction if you can hear stage noise in the vocal mic, and keep
   it low.

Notches release themselves after about 25 seconds without the tone returning, so the
plugin recovers on its own if you move a mic or change the monitor mix.

---

## What it will and will not do

**It will** catch sustained ringing quickly — typically within a quarter of a second —
and hold it down without you touching anything.

**It will not** fix a badly aimed monitor, a mic pointed at a speaker, or a stage that is
simply too loud. It buys you roughly 8 dB of extra gain before feedback in a typical
room. That is a large, useful margin. It is not unlimited, and no plugin's is.

**It deliberately leaves music alone.** Sustained instrument notes, held vowels and
sibilance are all tested against and should never be notched. If you find something it
notches that it should not, that is a bug worth reporting — include what instrument and
what note.

---

## Troubleshooting

**It mutes every 15 seconds.** That is demo mode. Enter your activation key.

**My key is rejected.** Check for a typo: there is no letter O (that's a zero), no I or L
(those are ones), and no U. Case and dashes do not matter.

**The voice sounds thin or hollow.** Too many notches. Lower the notch limit, and check
you have not put the plugin on the master bus.

**Sustained notes sound slightly detuned.** That is the shift. Lower it toward 3 Hz.

**Quiet words disappear.** Noise reduction is too high. Lower the knob or switch it off.

**It reacts too slowly.** Raise the notch limit so it has spare slots, and make sure the
shift is at 5 Hz or above.

**I hear a delay when monitoring.** It is not this plugin — it reports zero latency in
every mode, noise reduction included. Look at your interface's buffer size, and at
anything else in the channel: linear-phase EQ, lookahead limiting and most noise
reduction all add delay.

---

## Credits

Noise reduction is LOST's own spectral suppressor, written for this plug-in. Nothing is
downloaded, and no other plug-in has to be installed for it to work.

Built with JUCE. See `THIRD-PARTY.txt` in this folder for the full notices.

© 2026 LOST. Developed by noobkodak.
