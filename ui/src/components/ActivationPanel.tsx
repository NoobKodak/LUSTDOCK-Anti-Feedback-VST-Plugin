import { useCallback, useEffect, useRef, useState } from "react";

import { activate } from "../bridge";

interface ActivationPanelProps {
  onClose: () => void;
  onActivated: () => void;
}

const groups = 4;
const perGroup = 4;
const total = groups * perGroup;

/** Crockford base32: no I, L, O or U. Typed I/L become 1 and O becomes 0, which is what
 *  the verifier does too, so a key read off a phone still works. */
const allowed = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function clean(input: string): string {
  return input
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .split("")
    .filter((c) => allowed.includes(c))
    .join("");
}

/** OTP-style key entry: sixteen boxes in four groups, typing advances, backspace
 *  retreats, and pasting a whole key fills everything at once. */
export function ActivationPanel({ onClose, onActivated }: ActivationPanelProps) {
  const [chars, setChars] = useState<string[]>(() => Array(total).fill(""));
  const [status, setStatus] = useState<"idle" | "checking" | "bad" | "good">("idle");

  /*  Whatever the server said. Held rather than derived, because "that key is on three
      computers already" and "that key was never issued" call for completely different
      actions and only the server knows which applies.                                */
  const [message, setMessage] = useState("");
  const [offline, setOffline] = useState(false);

  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const focusBox = (index: number) => {
    const clamped = Math.min(total - 1, Math.max(0, index));
    inputs.current[clamped]?.focus();
    inputs.current[clamped]?.select();
  };

  useEffect(() => {
    focusBox(0);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = useCallback(
    (key: string) => {
      setStatus("checking");
      setMessage("");
      setOffline(false);

      activate(key).then((result) => {
        if (result?.ok) {
          setStatus("good");
          setMessage(result.message ?? "");
          // Let the ACTIVATED message land before the panel disappears.
          window.setTimeout(onActivated, 1200);
        } else {
          setStatus("bad");
          setMessage(result?.message ?? "That key could not be activated.");
          setOffline(Boolean(result?.offline));

          /*  The boxes are not cleared. A key refused because it is on three machines
              is a correctly typed key, and wiping it would make the customer type
              sixteen characters again to reach the same answer.                      */
          window.setTimeout(() => focusBox(0), 0);
        }
      });
    },
    [onActivated]
  );

  const write = (index: number, text: string) => {
    const incoming = clean(text);
    if (incoming.length === 0) return;

    const next = [...chars];
    let cursor = index;

    for (const c of incoming) {
      if (cursor >= total) break;
      next[cursor++] = c;
    }

    setChars(next);
    setStatus("idle");
    focusBox(cursor);

    /*  Empty boxes contribute nothing to the join, so a full sixteen characters is
        already proof that none are blank. The guard that used to sit here also asked
        `!assembled.includes("")`, which is true of every string in JavaScript -- so it
        was always false and the key never submitted itself. Enter still worked, which
        is why it went unnoticed.                                                      */
    const assembled = next.join("");
    if (assembled.length === total) submit(assembled);
  };

  return (
    <div className="hud-activate" role="dialog" aria-label="Activation key">
      <div className="hud-activate-label">ENTER ACTIVATION KEY</div>

      {/*  Said before they type, not after it fails.

          Activating needs the internet exactly once. Finding that out from an error
          message, on a stage, ten minutes before a set, is the worst possible moment --
          so it is stated up front, together with the part that matters more: it never
          needs the internet again afterwards.                                         */}
      <div className="hud-activate-note">
        <span className="hud-activate-note-dot" aria-hidden="true" />
        <span>
          <b>Needs the internet, once.</b> This computer is registered to your licence,
          then works offline forever &mdash; including on stage.
        </span>
      </div>

      <div className={`hud-otp ${status === "bad" ? "is-bad" : ""}`}>
        {Array.from({ length: groups }, (_, g) => (
          <div className="hud-otp-group" key={g}>
            {Array.from({ length: perGroup }, (_, i) => {
              const index = g * perGroup + i;

              return (
                <input
                  key={index}
                  ref={(el) => (inputs.current[index] = el)}
                  className="hud-otp-box"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={1}
                  value={chars[index]}
                  aria-label={`Character ${index + 1}`}
                  onChange={(event) => write(index, event.target.value)}
                  onPaste={(event) => {
                    event.preventDefault();
                    write(index, event.clipboardData.getData("text"));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Backspace") {
                      event.preventDefault();
                      const next = [...chars];

                      if (next[index]) next[index] = "";
                      else if (index > 0) next[index - 1] = "";

                      setChars(next);
                      setStatus("idle");
                      focusBox(chars[index] ? index : index - 1);
                    } else if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      focusBox(index - 1);
                    } else if (event.key === "ArrowRight") {
                      event.preventDefault();
                      focusBox(index + 1);
                    } else if (event.key === "Enter") {
                      const assembled = chars.join("");
                      if (assembled.length === total) submit(assembled);
                    }
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className={`hud-activate-status is-${status}`} role="status" aria-live="polite">
        {status === "checking" && "CONTACTING THE LICENCE SERVER"}
        {status === "good" && "ACTIVATED"}
        {status === "bad" && (offline ? "NO CONNECTION" : "NOT ACTIVATED")}
        {status === "idle" && " "}
      </div>

      {/*  The server's own sentence, verbatim.

          The line above says whether it worked; this says why, and it is the only part
          that implies an action -- release a seat on the shop, check the connection,
          look at what was typed. Set in normal case on purpose: a paragraph in the
          tracked-out capitals used everywhere else here is unreadable.                */}
      {message !== "" && status === "bad" && (
        <div className="hud-activate-reason">{message}</div>
      )}

      <button type="button" className="hud-picker-close" onClick={onClose}>
        CLOSE
      </button>
    </div>
  );
}
