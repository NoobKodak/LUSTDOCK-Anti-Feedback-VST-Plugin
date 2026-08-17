import { Link, NavLink } from "react-router-dom";
import { Volume2, VolumeX } from "lucide-react";

import { useSound } from "@/lib/sound";
import { cn } from "@/lib/utils";

/** Small, and out of the way at the end of the nav. It is a preference, not a feature,
 *  so it does not get a label competing with the three routes. */
function SoundToggle() {
  const { enabled, toggle } = useSound();

  return (
    <button
      type="button"
      onClick={toggle}
      data-sound="off"
      aria-pressed={enabled}
      title={enabled ? "Turn the click off" : "Turn the click on"}
      className={cn(
        "ml-1 grid size-9 place-items-center rounded-full transition-colors",
        enabled ? "text-foreground" : "text-foreground/40 hover:text-foreground/70"
      )}
    >
      {enabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
      <span className="sr-only">{enabled ? "Sound on" : "Sound off"}</span>
    </button>
  );
}

/*  Hidden, not deleted.

    /plugins still exists and still works -- the catalogue is reachable by URL, the
    product pages link back to it, and anything already pointing at it keeps working.
    It is only off the nav while there is one plug-in to show, because a menu item
    leading to a list of one is a detour rather than a route. Set `hidden: false` when
    there is a second product and it comes straight back.                            */
const links = [
  { to: "/", label: "Home", end: true, hidden: false },
  { to: "/plugins", label: "Plug-ins", end: false, hidden: true },
  { to: "/orders", label: "Find my key", end: false, hidden: false },
];

/*  Centred mark over a centred nav.

    The logo is the loudest thing on the page and is doing the branding on its own, so it
    gets the middle and nothing competes with it -- no call to action up here. The only
    buttons on the page are the two in the hero, which is what makes them impossible to
    miss.

    The nav is not sticky. On a page this short a bar following you down adds nothing and
    costs a strip of the artwork.
*/
export function Header() {
  return (
    <header className="pt-10 pb-2">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col items-center px-6 sm:px-10">
        <Link to="/" aria-label="LOST — home" className="inline-block">
          <img
            src="/brand/logo-lost.webp"
            alt="LOST"
            className="h-[100px] w-auto"
            draggable={false}
          />
        </Link>

        <nav className="mt-3 flex flex-wrap items-center justify-center gap-x-2 sm:gap-x-[51px]">
          {links.filter((l) => !l.hidden).map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                cn(
                  "relative flex h-11 items-center rounded-md px-3 t-body transition-colors",
                  "after:absolute after:inset-x-3 after:bottom-2 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform",
                  "hover:text-foreground hover:after:scale-x-100",
                  isActive ? "text-foreground after:scale-x-100" : "text-foreground/70"
                )
              }
            >
              {l.label}
            </NavLink>
          ))}

          <SoundToggle />
        </nav>
      </div>
    </header>
  );
}

/*  The banner that stops anyone mistaking this for a real shop.

    Shown unless the deployment says otherwise, and that direction matters. It was a
    hardcoded strip that had to be remembered and deleted on the day payments went live;
    the failure mode of forgetting was a real shop still telling buyers their money was
    not being taken, and the failure mode of deleting it early was a simulated shop
    claiming to be real. Neither is a thing to leave to memory.

    Now it is one variable, set in the same place and at the same moment as the live
    PayPal client id -- which is the other half of going live, and the half that actually
    moves money. Set them together, one build, and the label can never disagree with what
    the checkout is really doing.                                                       */
export function DemoStrip() {
  if (import.meta.env.VITE_STORE_LIVE === "1") return null;

  return (
    <div className="bg-primary/12 py-2 text-center t-label text-primary">
      Demonstration store — payments are simulated, no money is taken
    </div>
  );
}
