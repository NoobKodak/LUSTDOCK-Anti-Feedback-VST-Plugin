import { useSound } from "../useSound";

interface NoiseSwitchProps {
  on: boolean;
  onToggle: (value: boolean) => void;
}

/** The noise on/off toggle.
 *
 *  newcasing.svg already has the switch painted at this exact rect -- the SVG declares
 *  it as an 83 x 154 rect at 972, 570 -- so the overlay sits directly on top of it and
 *  simply swaps the ON artwork for the OFF one.
 */
export function NoiseSwitch({ on, onToggle }: NoiseSwitchProps) {
  const click = useSound("sound effect/switch sound effect.mp3");

  return (
    <button
      type="button"
      className="noise-switch"
      role="switch"
      aria-checked={on}
      aria-label="Noise reduction"
      title={on ? "Noise reduction ON" : "Noise reduction OFF"}
      onClick={() => {
        click();
        onToggle(!on);
      }}
    >
      <img
        src={on ? "noiseswitch on.svg" : "noiseswitch off.svg"}
        alt=""
        draggable={false}
      />
    </button>
  );
}
