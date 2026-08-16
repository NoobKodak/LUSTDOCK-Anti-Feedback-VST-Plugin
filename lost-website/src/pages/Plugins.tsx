import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { money, type Product } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/*  One plug-in, as a full-width row.

    Rows rather than a grid of cards, because the shop currently sells one thing. A
    three-column grid renders that as one card and two holes, which reads as a page that
    failed to load rather than a shop with one good product. A row is correct at one item
    and still correct at ten -- it just gets longer.

    It also gives each product room to say what it is and what it costs without the
    truncation a card forces, and the price sits next to the action rather than three
    lines above it.
*/
export function PluginRow({ product, className }: { product: Product; className?: string }) {
  return (
    <article
      className={cn(
        "group grid items-center gap-8 border-t border-border py-10 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-12 lg:py-14",
        className
      )}
    >
      <Link
        to={`/plugins/${product.slug}`}
        className="order-1 block overflow-hidden rounded-2xl bg-muted/50 sm:order-none"
        tabIndex={-1}
        aria-hidden
      >
        {product.image_path ? (
          <img
            src={product.image_path}
            alt=""
            className="w-full transition-transform duration-300 group-hover:scale-[1.02]"
            draggable={false}
          />
        ) : (
          <div className="grid aspect-16/10 place-items-center t-label text-muted-foreground">
            No image
          </div>
        )}
      </Link>

      <div>
        {product.badge && <Badge variant="blue" className="mb-4">{product.badge}</Badge>}

        <h2 className="t-title">
          {/* The whole row is not a link -- only the name and the button are, so the
              price and platform stay selectable. */}
          <Link
            to={`/plugins/${product.slug}`}
            className="rounded-sm transition-colors hover:text-primary"
          >
            {product.name}
          </Link>
        </h2>

        {product.tagline && (
          <p className="t-body mt-3 max-w-[52ch] text-muted-foreground">{product.tagline}</p>
        )}

        <p className="t-small mt-4 text-muted-foreground">{product.platform}</p>

        <div className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-4">
          <span className="t-title t-numeric">{money(product.price_cents, product.currency)}</span>

          <Button asChild variant="outline" className="px-6">
            <Link to={`/plugins/${product.slug}`}>
              View plug-in <ArrowRight />
            </Link>
          </Button>

          {!product.in_stock && (
            <Badge variant="destructive">Out of stock</Badge>
          )}
        </div>
      </div>
    </article>
  );
}

export function Plugins({ products }: { products: Product[] }) {
  const count = products.length;

  return (
    <section className="mx-auto w-full max-w-[1400px] px-6 py-10 sm:px-10">
      <p className="t-label text-muted-foreground">Plug-ins</p>
      <h1 className="t-display mt-3 max-w-2xl text-balance">
        Tools built for the stage first
      </h1>
      <p className="t-body mt-5 max-w-[58ch] text-muted-foreground">
        One-time purchase, offline activation, no subscription on any of them. Every
        number on these pages comes from a test bench rather than a marketing meeting.
      </p>

      {count === 0 ? (
        /*  An empty shop should say what to do next, not just report emptiness. This is
            the owner's own admin panel, so the way out is one click away.             */
        <div className="mt-12 rounded-3xl border-[3px] border-black px-8 py-16 text-center">
          <h2 className="t-title">Nothing is listed yet</h2>
          <p className="t-body mx-auto mt-4 max-w-sm text-muted-foreground">
            Plug-ins appear here once they are switched on in the admin panel.
          </p>
          <Button asChild className="mt-8">
            <Link to="/admin">Open the admin panel</Link>
          </Button>
        </div>
      ) : (
        <>
          <p className="t-label mt-12 text-muted-foreground">
            {count} {count === 1 ? "plug-in" : "plug-ins"}
          </p>

          <div>
            {products.map((p) => <PluginRow key={p.slug} product={p} />)}
          </div>
        </>
      )}
    </section>
  );
}
