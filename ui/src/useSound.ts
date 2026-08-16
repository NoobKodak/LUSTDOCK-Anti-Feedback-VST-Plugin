import { useCallback, useRef } from "react";

/** Plays a one-shot click from the plug-in's own resources.
 *
 *  The path stays relative so it resolves both under the Vite dev server, which serves
 *  the real folder, and inside the plug-in, where the resource provider matches on the
 *  last path segment only.
 */
export function useSound(url: string) {
  const element = useRef<HTMLAudioElement | null>(null);

  return useCallback(() => {
    if (!element.current) {
      element.current = new Audio(url);
      element.current.preload = "auto";
    }

    // Rewinding matters: without it a second click inside the sample's length is
    // silently ignored, and the control feels broken.
    element.current.currentTime = 0;
    void element.current.play().catch(() => {
      // Autoplay policy or a missing file. The control still works; only the click is lost.
    });
  }, [url]);
}
