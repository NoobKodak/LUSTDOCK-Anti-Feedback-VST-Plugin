import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Delivery, IssuedKey } from "@/lib/supabase";

/** On-screen delivery. The key is the product, so it gets the most legible treatment on
 *  the page and a copy button rather than asking anyone to transcribe it by eye. */
export function KeyDelivery({ keys, deliveries }: { keys: IssuedKey[]; deliveries: Delivery[] }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const emailed = deliveries.filter((d) => d.channel === "email");
  const recipient = emailed[0]?.recipient ?? null;
  const allSent = emailed.length > 0 && emailed.every((d) => d.status === "sent");

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {keys.map((k) => (
          <div
            key={k.key_code}
            className="flex flex-wrap items-center gap-4 rounded-xl border-2 border-dashed border-duck-mint/60 bg-duck-mint/8 px-5 py-4"
          >
            <span className="flex-1 text-base font-bold tracking-[0.1em] break-all sm:text-xl">
              {k.key_code}
            </span>

            <Button variant="outline" size="sm" onClick={() => copy(k.key_code)}>
              {copied === k.key_code ? <><Check /> Copied</> : <><Copy /> Copy</>}
            </Button>
          </div>
        ))}
      </div>

      {recipient && (
        <p className="t-small text-muted-foreground">
          {allSent ? (
            <>A copy has been emailed to <b className="text-foreground">{recipient}</b>.</>
          ) : (
            <>
              A copy is queued for <b className="text-foreground">{recipient}</b>. In this
              demo no mail provider is connected, so the email is recorded rather than
              sent — your key is on this page and in <b className="text-foreground">Find
              my key</b> whenever you need it.
            </>
          )}
        </p>
      )}

      <div className="rounded-xl bg-muted p-5">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          How to activate
        </p>
        <ol className="mt-3 space-y-1.5 t-body text-muted-foreground">
          <li>1. Open the plug-in in your DAW, or the standalone app.</li>
          <li>2. Click the red <b className="text-foreground">DEMO</b> badge on the screen.</li>
          <li>3. Type or paste the key above. Dashes and case do not matter.</li>
        </ol>
      </div>
    </div>
  );
}

