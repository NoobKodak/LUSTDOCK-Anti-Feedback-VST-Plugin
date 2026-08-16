import { Link } from "react-router-dom";
import { CircleArrowDown } from "lucide-react";

import { DeviceShowcase } from "@/components/DeviceShowcase";
import { Reviews } from "@/components/Reviews";
import { PluginRow } from "@/pages/Plugins";
import { Button } from "@/components/ui/button";
import { money, type Product } from "@/lib/supabase";

/*  The front page.

    Copy on the left, artwork on the right, and the artwork is deliberately the bigger
    half: the hand-drawn surround carries the product's character and the device is what
    people came to look at. The copy column stays narrow enough to read in one fixation
    -- around 58 characters -- rather than filling whatever space is left over.

    The lead product gets the hero because that is what the shop is for; anything else
    listed appears below, so adding a second plug-in never means rebuilding this page.
*/
export function Landing({ products }: { products: Product[] }) {
  const lead = products[0];
  const rest = products.slice(1);

  if (!lead) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-24 text-center sm:px-10">
        <h1 className="t-title">Nothing is listed yet.</h1>
        <p className="mt-3 t-body text-muted-foreground">
          Add a plug-in in the admin panel and switch it on.
        </p>
      </div>
    );
  }

  return (
    <>
      <section className="mx-auto grid w-full max-w-[1400px] items-center gap-10 px-6 pt-6 pb-16 sm:px-10 lg:grid-cols-[minmax(0,0.62fr)_minmax(0,0.92fr)] lg:gap-12">
        <div>
          <img
            src="/brand/lost-duck-text-logo.webp"
            alt={lead.name}
            className="mb-7 w-full max-w-[327px]"
            draggable={false}
          />

          {lead.tagline && <p className="t-body mb-8">{lead.tagline}</p>}

          <h1 className="t-body mb-4">LOST DUCK &mdash; AI Anti-Feedback VST</h1>

          {lead.description && (
            <p className="max-w-[58ch] t-body text-foreground/80">{lead.description}</p>
          )}

          {/* Widths and the gap between them come from Figma: 521 and 637 wide, 154
              apart, in a 4686 frame -- 156px, 190px and 46px once scaled. */}
          <div className="mt-10 flex flex-wrap items-center gap-x-[46px] gap-y-4">
            {lead.in_stock ? (
              <Button asChild size="lg" className="w-[156px] px-0">
                <Link to={`/checkout/${lead.slug}`}>
                  BUY - {money(lead.price_cents, lead.currency)}
                </Link>
              </Button>
            ) : (
              <Button size="lg" disabled className="w-[156px] px-0">OUT OF STOCK</Button>
            )}

            <Button asChild variant="outline" size="lg" className="w-[190px] px-0">
              <Link to={`/plugins/${lead.slug}`}>
                <CircleArrowDown /> Try the demo
              </Link>
            </Button>
          </div>
        </div>

        <DeviceShowcase className="lg:justify-self-end" />
      </section>

      {/* Below the pitch and the artwork: somebody still deciding has now seen what the
          thing is, and other people's experience is what they want next. */}
      <Reviews slug={lead.slug} />

      {rest.length > 0 && (
        <section className="mx-auto w-full max-w-[1400px] px-6 py-16 sm:px-10">
          {/* Same row as the catalogue rather than a second card style -- one component,
              so the two pages cannot drift apart. */}
          <h2 className="t-title">More from LOST</h2>
          <div className="mt-6">
            {rest.map((p) => <PluginRow key={p.slug} product={p} />)}
          </div>
        </section>
      )}
    </>
  );
}
