import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "lost.sound";
const CLIP = "/sfx/switch.mp3";

/*  The click.

    The plug-in is a box with a physical switch on it, and the shop is meant to feel like
    the same object. A click on the buttons is the cheapest way to carry that across --
    but sound on a web page is an imposition in a way that colour is not, so:

      - It starts off. Somebody opening this at work, or on a train, gets silence until
        they ask for it. Browsers refuse to play audio before a first interaction anyway,
        so an on-by-default setting would half-fail on the first click regardless.

      - The preference is remembered, so it is asked once and never again.

      - It is off for anyone who has asked the system for reduced motion. That setting is
        a request for a calmer interface, and a noise on every click is not calmer.

    One <audio> element is reused rather than one per click. Constructing an Audio per
    press leaks elements on a page somebody is clicking through quickly, and rewinding a
    single element is what makes rapid clicks retrigger cleanly instead of overlapping
    into mush.                                                                          */

interface SoundApi {
  enabled: boolean;
  toggle: () => void;
  play: () => void;
}

const SoundContext = createContext<SoundApi>({
  enabled: false,
  toggle: () => {},
  play: () => {},
});

export const useSound = () => useContext(SoundContext);

/** True when the visitor has asked for less motion. Read once at startup. */
function prefersCalm() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    if (prefersCalm()) return false;
    return localStorage.getItem(STORAGE_KEY) === "on";
  });

  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = new Audio(CLIP);
    el.preload = "auto";
    el.volume = 0.35;   // a UI tick, not an event
    audio.current = el;

    return () => { el.pause(); audio.current = null; };
  }, []);

  const play = useCallback(() => {
    const el = audio.current;
    if (!el || !enabled) return;

    /*  Rewind rather than wait. Without this a second click inside the clip's length is
        simply dropped, which reads as the button not having registered.               */
    el.currentTime = 0;

    // Autoplay policy can still refuse; a silent failure is the right one here.
    void el.play().catch(() => {});
  }, [enabled]);

  const toggle = useCallback(() => {
    setEnabled((was) => {
      const now = !was;
      localStorage.setItem(STORAGE_KEY, now ? "on" : "off");

      /*  Play the click that turns it on, so the answer to "what does this do" is the
          thing itself. Done here rather than through `play`, which is still holding the
          old value on this render.                                                    */
      if (now && audio.current) {
        audio.current.currentTime = 0;
        void audio.current.play().catch(() => {});
      }

      return now;
    });
  }, []);

  /*  One listener on the document rather than a handler on every button.

      Buttons live in shadcn components, in Radix primitives, in the admin panel and in
      pages not written yet. Wiring each one would mean every future button is silent
      until somebody remembers -- so the rule is enforced in one place, matching on what
      an element *is* rather than on it having opted in.                               */
  useEffect(() => {
    if (!enabled) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest) return;

      const hit = target.closest<HTMLElement>(
        'button, a[href], [role="button"], [role="tab"], summary'
      );

      if (!hit) return;

      // Nothing happened, so nothing should sound.
      if (hit.hasAttribute("disabled") || hit.getAttribute("aria-disabled") === "true") return;

      // The toggle makes its own noise; this would double it.
      if (hit.dataset.sound === "off") return;

      play();
    };

    /*  pointerdown, not click: the sound belongs to the press. On click it lands after
        the button has already visually depressed, which reads as lag.                 */
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [enabled, play]);

  const value = useMemo(() => ({ enabled, toggle, play }), [enabled, toggle, play]);

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}
