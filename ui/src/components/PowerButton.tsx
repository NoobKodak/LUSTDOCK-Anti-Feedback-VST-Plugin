import { useSound } from "../useSound";

interface PowerButtonProps {
  on: boolean;
  onToggle: (value: boolean) => void;
}

/** The bypass button. It sits directly over the button painted into newcasing.svg and
 *  is drawn a little larger so no rim of the artwork shows through.
 *
 *  No glow: the artwork already reads as a lit lamp, and adding a halo behind it spilled
 *  orange onto the white ring and the graffiti around it. Off state is greyscale only.
 */
export function PowerButton({ on, onToggle }: PowerButtonProps) {
  const click = useSound("sound effect/bypass btn sound effect.mp3");

  return (
    <button
      type="button"
      className={`power ${on ? "is-on" : "is-off"}`}
      onClick={() => {
        click();
        onToggle(!on);
      }}
      aria-pressed={on}
      aria-label={on ? "Anti-feedback on" : "Anti-feedback off"}
      title={on ? "Anti-feedback ON" : "Anti-feedback OFF"}
    >
      <img src="button.svg" alt="" draggable={false} />
    </button>
  );
}
