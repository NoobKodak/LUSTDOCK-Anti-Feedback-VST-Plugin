import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft, Check, CircleArrowDown, ShieldCheck, PlayCircle, Gauge, ListChecks,
  FlaskConical,
} from "lucide-react";

import { DemoVideo } from "@/components/DemoVideo";
import { DeviceShowcase } from "@/components/DeviceShowcase";
import { DownloadPanel } from "@/components/Download";
import { Button } from "@/components/ui/button";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, LinkedCard,
  Separator, Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/misc";
import { fetchProduct, money, saving, type Product } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/*  One plug-in's page, rendered entirely from its database row.

    Deliberately not a second copy of the home page. The front page already makes the
    pitch -- wordmark, artwork, the paragraph -- so repeating it here would mean somebody
    who followed "Try the demo" arrives somewhere that looks like where they just left,
    and has to hunt for the download they were promised.

    So this page answers what the front page does not: the measured numbers, the
    download, the specification, and the questions. The order follows the reason people
    arrive -- try it, then check it will work, then buy.

    Sections hide themselves when the product has nothing to put in them, so a
    half-filled draft still produces a sensible page rather than empty headings.
*/
export function ProductPage() {
  const { slug = "" } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchProduct(slug)
      .then(setProduct)
      .catch(() => setProduct(null))
      .finally(() => setLoading(false));
  }, [slug]);

  /*  A skeleton in the shape of the page, not a spinner. The layout is known before the
      data is, so holding its shape means nothing jumps when the content lands.        */
  if (loading) {
    return (
      <div
        className="mx-auto w-full max-w-[1400px] px-6 py-12 sm:px-10"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">Loading the plug-in</span>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-5">
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="h-12 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="flex gap-4 pt-3">
              <div className="h-13 w-[156px] animate-pulse rounded-full bg-muted" />
              <div className="h-13 w-[190px] animate-pulse rounded-full bg-muted" />
            </div>
          </div>
          <div className="aspect-[8086/6423] w-full animate-pulse rounded-2xl bg-muted" />
        </div>
      </div>
    );
  }

  /*  A dead end needs a way out: what happened, then what to do about it.             */
  if (!product) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-24 sm:px-10">
        <p className="t-label text-muted-foreground">Not found</p>
        <h1 className="t-display mt-3 mb-3">That plug-in isn&rsquo;t here.</h1>
        <p className="t-body mb-8 max-w-md text-muted-foreground">
          Nothing we sell lives at <span className="text-foreground">/plugins/{slug}</span>.
          It may have been renamed.
        </p>
        <Button asChild><Link to="/plugins">See every plug-in</Link></Button>
      </div>
    );
  }

  const price = money(product.price_cents, product.currency);
  const offer = saving(product);

  return (
    <>
      {/* ------------------------------------------------------------- hero */}
      <section className="mx-auto grid w-full max-w-[1400px] items-center gap-10 px-6 pt-4 pb-14 sm:px-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
        <div>
          <Link
            to="/plugins"
            className="inline-flex items-center gap-2 t-small text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> All plug-ins
          </Link>

          {/* The tagline leads, not the product name. Somebody who followed a link from
              the front page already knows what this is called; what they want to know
              is what it does for them. */}
          <h1 className="t-display mt-5 text-balance">{product.tagline ?? product.name}</h1>

          <p className="t-body mt-3 text-muted-foreground">
            {product.name} &middot; v{product.version} &middot; {product.platform}
          </p>

          {/*  Price before buttons.

              The old price and the saving sit *beside* the number rather than inside the
              button, because a button that reads "BUY - was $199 now $99.99 save 50%" is
              not a button, it is a paragraph you can click.                            */}
          <div className="mt-8 flex flex-wrap items-end gap-x-4 gap-y-2">
            <span className="t-display t-numeric leading-none">{price}</span>

            {offer && (
              <>
                <span className="t-body t-numeric text-muted-foreground line-through decoration-2">
                  {offer.wasText}
                </span>
                <Badge className="mb-1">Save {offer.offText}</Badge>
              </>
            )}
          </div>

          {offer && (
            <p className="mt-2 t-small text-muted-foreground">
              Launch offer &mdash; {offer.percent}% off while the first run lasts.
            </p>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-x-[46px] gap-y-4">
            {product.in_stock ? (
              <Button asChild size="lg" className="w-[156px] px-0">
                <Link to={`/checkout/${product.slug}`}>BUY - {price}</Link>
              </Button>
            ) : (
              <Button size="lg" disabled className="w-[156px] px-0">OUT OF STOCK</Button>
            )}

            <Button asChild variant="outline" size="lg" className="w-[190px] px-0">
              <a href="#download"><CircleArrowDown /> Try the demo</a>
            </Button>
          </div>

          <p className="mt-6 flex items-center gap-2 t-small text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            One-time payment &middot; offline activation &middot; free 1.x updates
          </p>
        </div>

        <DeviceShowcase className="lg:justify-self-end" />
      </section>

      {/* -------------------------------------------------------- quick nav
          The page is long and people arrive wanting one of three things. Rather
          than making everyone scroll to find out which, the three are offered
          up front and jump straight there.                                    */}
      <section className="mx-auto w-full max-w-[1400px] px-6 pb-4 sm:px-10">
        <div className="grid gap-4 sm:grid-cols-3 sm:gap-6">
          <LinkedCard href="#demo" className="items-start gap-1 p-6 text-sm">
            <PlayCircle className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            <div className="font-bold">See it working</div>
            <div className="leading-relaxed text-muted-foreground">
              A walkthrough of it catching a live howl.
            </div>
          </LinkedCard>

          <LinkedCard href="#download" className="items-start gap-1 p-6 text-sm">
            <CircleArrowDown className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            <div className="font-bold">Try it yourself</div>
            <div className="leading-relaxed text-muted-foreground">
              The same build buyers get, free to run in demo mode.
            </div>
          </LinkedCard>

          <LinkedCard href="#detail" className="items-start gap-1 p-6 text-sm">
            <Gauge className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            <div className="font-bold">Check the numbers</div>
            <div className="leading-relaxed text-muted-foreground">
              Bench figures, specification and the questions.
            </div>
          </LinkedCard>
        </div>
      </section>

      {/* ---------------------------------------------------------- numbers
          Given the top of the page because it is the one thing no competitor
          can copy without doing the work: these are bench figures, and saying
          so is the claim.                                                     */}
      {product.highlights.length > 0 && (
        /*  The bench readout.

            Four equal boxes on a yellow field made four equal claims, and they are not
            equal -- the gain figure is the one the product is bought on and the rest
            support it. So the first is set large against the others, and the panel is
            inverted to black: it is the only dark band on the page, which is what makes
            a reader stop at it rather than scroll past another card grid.

            Rules instead of borders. Boxed numbers read as buttons, and there is nothing
            here to press.                                                              */
        <section className="bg-black">
          <div className="mx-auto w-full max-w-[1400px] px-6 py-14 sm:px-10 sm:py-16">
            <p className="flex items-center gap-2.5 t-label text-[#FFE500]">
              <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
              Measured on a bench, not estimated
            </p>

            {/*  A definition list, and each label appears exactly once.

                It used to render twice -- an sr-only <dt> carrying the label and a
                visible <span> repeating it -- so a screen reader read every caption
                twice over. The <dt> is the visible element now, which is what it was
                always for.                                                            */}
            <dl className="mt-10 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr]">
              {product.highlights.map((h, i) => (
                <div
                  key={i}
                  className={cn(
                    "group relative",
                    // A hairline between figures on the wide layout only; stacked, the
                    // spacing already separates them and a rule would just be noise.
                    i > 0 && "lg:border-l lg:border-white/15 lg:pl-10"
                  )}
                >
                  <dd
                    className={cn(
                      "t-numeric leading-[0.95] text-[#FFE500] transition-transform duration-200",
                      "origin-left group-hover:scale-[1.04]",
                      i === 0
                        ? "text-[clamp(3rem,2rem+4.4vw,5.25rem)]"
                        : "text-[clamp(2rem,1.5rem+1.8vw,2.75rem)]"
                    )}
                  >
                    {h.value}
                  </dd>

                  <dt
                    className={cn(
                      "mt-4 font-bold text-white",
                      i === 0 ? "text-base" : "text-sm"
                    )}
                  >
                    {h.label}
                  </dt>

                  {h.detail && (
                    <p className="mt-2 max-w-[34ch] t-small text-white/45">{h.detail}</p>
                  )}
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      {/* --------------------------------------------------------------- demo */}
      <section id="demo" className="mx-auto w-full max-w-[1400px] scroll-mt-8 px-6 py-16 sm:px-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div className="lg:sticky lg:top-10 lg:self-start">
            <p className="t-label text-muted-foreground">See it working</p>
            <h2 className="t-display mt-3 max-w-sm text-balance">
              The sound of nothing happening
            </h2>
            <p className="t-body mt-4 max-w-sm text-muted-foreground">
              Anti-feedback is a hard thing to show, because working perfectly means a
              howl that never arrives. Watch the gain go up instead.
            </p>
          </div>

          <DemoVideo
            src={product.demo_video_path}
            poster={product.demo_poster_path}
            className="aspect-video w-full"
          />
        </div>
      </section>

      {/* ----------------------------------------------------------- download
          High on the page: "Try the demo" points here, and making somebody
          scroll past the sales pitch to reach what they were promised is a
          bait and switch.                                                     */}
      <section id="download" className="mx-auto w-full max-w-[1400px] scroll-mt-8 px-6 py-16 sm:px-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div>
            <p className="t-label text-muted-foreground">Try before you buy</p>
            <h2 className="t-title mt-3">The same build, either way</h2>
            <p className="t-body mt-4 text-muted-foreground">
              Without a key it runs in demo mode: everything works, but the output
              silences periodically. Buy a key at any point and it stops &mdash; no
              second download, no reinstall.
            </p>
          </div>

          <DownloadPanel slug={product.slug} />
        </div>
      </section>

      {/* ------------------------------------------------------------- detail
          How it works, the specification and the questions were three stacked
          sections, which meant somebody who only wanted to know "will this run
          at 96 kHz" had to scroll past an essay to find out. They are three
          answers to three different questions, so they are three tabs.

          Each panel still renders only if the product has that content, and the
          tab strip only appears when there is more than one -- a lone tab is a
          control that cannot do anything.                                      */}
      {(product.features.length > 0 || product.specs.length > 0 || product.faq.length > 0) && (
        <section id="detail" className="mx-auto w-full max-w-[1400px] scroll-mt-8 px-6 py-16 sm:px-10">
          <Tabs defaultValue={product.features.length > 0 ? "how" : product.specs.length > 0 ? "specs" : "faq"}>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="t-label text-muted-foreground">The detail</p>
                <h2 className="t-display mt-3 max-w-md text-balance">
                  Everything else you would ask
                </h2>
              </div>

              <TabsList>
                {product.features.length > 0 && <TabsTrigger value="how">How it works</TabsTrigger>}
                {product.specs.length > 0 && <TabsTrigger value="specs">Specification</TabsTrigger>}
                {product.faq.length > 0 && <TabsTrigger value="faq">Questions</TabsTrigger>}
              </TabsList>
            </div>

            <Separator className="mt-8 mb-2" />

            {product.features.length > 0 && (
              <TabsContent value="how">
                <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
                  <p className="t-body max-w-sm text-muted-foreground lg:sticky lg:top-10 lg:self-start">
                    Most suppressors wait for the howl and then notch it. Waiting is the
                    problem: by then the loop has already run away.
                  </p>

                  {/* Not 01/02/03 cards. The numbering asserted a sequence that does not
                      exist -- these defences run at the same time, which is the actual
                      selling point -- so a reader who trusted it learned something false. */}
                  <ul>
                    {product.features.map((f, i) => (
                      <li
                        key={i}
                        className={cn("border-t border-border py-7", i === 0 && "border-t-0 pt-0")}
                      >
                        <h3 className="t-heading">{f.title}</h3>
                        <p className="t-body mt-2 max-w-[62ch] text-muted-foreground">{f.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </TabsContent>
            )}

            {product.specs.length > 0 && (
              <TabsContent value="specs">
                <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
                  <p className="t-body max-w-sm text-muted-foreground lg:sticky lg:top-10 lg:self-start">
                    <ListChecks className="mb-3 size-5" aria-hidden="true" />
                    Will it run on your rig? If anything here rules you out, do not buy
                    it &mdash; take the demo build first.
                  </p>

                  <dl className="t-body">
                    {product.specs.map(([label, value], i) => (
                      <div key={i}>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 py-4">
                          <dt className="t-small text-muted-foreground">{label}</dt>
                          <dd className="t-numeric text-right">{value}</dd>
                        </div>
                        {i < product.specs.length - 1 && <Separator />}
                      </div>
                    ))}
                  </dl>
                </div>
              </TabsContent>
            )}

            {product.faq.length > 0 && (
              <TabsContent value="faq">
                <div className="max-w-3xl pt-6">
                  <Accordion type="single" collapsible defaultValue="item-0">
                    {product.faq.map((item, i) => (
                      <AccordionItem key={i} value={`item-${i}`}>
                        <AccordionTrigger>{item.q}</AccordionTrigger>
                        <AccordionContent>{item.a}</AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              </TabsContent>
            )}
          </Tabs>
        </section>
      )}

      {/* --------------------------------------------------------------- buy
          The page is long, and somebody who has read to the bottom has decided.
          One clear way to act, rather than making them scroll back up.        */}
      <section className="mx-auto w-full max-w-[1400px] px-6 pb-24 sm:px-10">
        {/*  Two columns, not a centred stack.

            Centred, the price sat under a paragraph and above a button and read as
            decoration. Here the left side is the argument and the right side is the
            transaction, so the number and the button are the same object and the eye
            lands on them together.                                                  */}
        <div className="grid overflow-hidden rounded-3xl border-[3px] border-black lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="px-8 py-12 sm:px-12">
            <h2 className="t-display text-balance">Ready when you are</h2>
            <p className="t-body mt-4 max-w-md text-muted-foreground">
              Your key appears on screen the moment the payment goes through, and again in
              your email. Nothing to activate online, and no account to make.
            </p>

            <ul className="mt-8 space-y-3">
              {[
                ["One-time payment", "No subscription, ever."],
                ["Works offline", "Activate once; the key lives on the machine."],
                ["Commercial use included", "Your gigs, your sessions, your clients."],
              ].map(([title, detail]) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground">
                    <Check className="size-3 text-background" strokeWidth={3} />
                  </span>
                  <span className="t-small">
                    <b className="text-foreground">{title}</b>{" "}
                    <span className="text-muted-foreground">{detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col justify-center border-t-[3px] border-black bg-[#FFE500] px-8 py-12 sm:px-12 lg:border-t-0 lg:border-l-[3px]">
            {offer && (
              <Badge className="mb-4 border-[2px] border-black bg-black text-[#FFE500]">
                {offer.percent}% off &mdash; launch price
              </Badge>
            )}

            <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
              <span className="t-display t-numeric leading-none text-black">{price}</span>
              {offer && (
                <span className="t-body t-numeric text-black/55 line-through decoration-2">
                  {offer.wasText}
                </span>
              )}
            </div>

            {offer && (
              <p className="mt-3 t-small text-black/70">
                You save {offer.offText} on every licence.
              </p>
            )}

            <div className="mt-8">
              {product.in_stock ? (
                <Button
                  asChild
                  size="lg"
                  className="w-full border-black bg-black px-0 text-[#FFE500] hover:bg-black/85"
                >
                  <Link to={`/checkout/${product.slug}`}>BUY - {price}</Link>
                </Button>
              ) : (
                <Button size="lg" disabled className="w-full px-0">OUT OF STOCK</Button>
              )}
            </div>

            <a
              href="#download"
              className="mt-4 text-center t-small text-black/70 underline underline-offset-4 transition-colors hover:text-black"
            >
              or download the demo first
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
