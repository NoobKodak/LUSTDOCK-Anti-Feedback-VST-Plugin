import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Check, CreditCard, Minus, Plus, ShieldCheck, Lock, ArrowLeft, Loader2,
} from "lucide-react";

import { DownloadPanel } from "@/components/Download";
import { KeyDelivery } from "@/components/KeyDelivery";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge, Label, Separator } from "@/components/ui/misc";
import { captureServerSide, loadPayPal, paypalConfig } from "@/lib/paypal";
import {
  createCheckout, failed, money, saving, sendKeyEmail,
  type OrderView, type Product,
} from "@/lib/supabase";
import { cn } from "@/lib/utils";

type Stage = "details" | "payment" | "done";

/*  The rail across the top.

    A progress bar rather than three pills, because three equal pills do not say which
    way the process runs or how much of it is left. The line fills as the stages advance,
    and a finished step keeps a tick so the rail reads as a record of what has happened
    rather than only as a pointer at what is happening.                                */
function StepRail({ current }: { current: number }) {
  const steps = ["Your details", "Payment", "Your key"];

  return (
    <ol className="flex items-center gap-2" aria-label="Checkout progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;

        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span
                className={cn(
                  "flex items-center gap-2 t-label transition-colors duration-300",
                  active ? "text-foreground" : done ? "text-emerald-700" : "text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border-2 text-[10px] transition-colors duration-300",
                    done
                      ? "border-emerald-700 bg-emerald-700 text-white"
                      : active
                        ? "border-foreground bg-foreground text-background"
                        : "border-foreground/25 text-muted-foreground"
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="truncate">{label}</span>
              </span>

              <span className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span
                  className={cn(
                    "block h-full rounded-full transition-[width,background-color] duration-500 ease-out",
                    done ? "w-full bg-emerald-700" : active ? "w-1/2 bg-foreground" : "w-0 bg-foreground"
                  )}
                />
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Checkout({ products }: { products: Product[] }) {
  const { slug = "" } = useParams();
  const product = products.find((p) => p.slug === slug) ?? null;

  const [stage, setStage] = useState<Stage>("details");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [quantity, setQuantity] = useState(1);

  const [orderNumber, setOrderNumber] = useState("");
  const [order, setOrder] = useState<OrderView | null>(null);
  const paypalMounted = useRef(false);

  const unit = product?.price_cents ?? 4900;
  const currency = product?.currency ?? "USD";
  const total = unit * quantity;

  /* Step one: create the order and its pending payment. Nothing is charged and no key is
     touched — this is the equivalent of creating a payment intent. */
  const startCheckout = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await createCheckout(email.trim(), fullName.trim(), quantity, slug);
    setBusy(false);

    if (failed(result)) {
      setError(
        result.available !== undefined
          ? `${result.error} (${result.available} left in stock)`
          : result.error
      );
      return;
    }

    setOrderNumber(result.order_number);
    setStage("payment");
  };

  /*  There is no `pay` here any more.

      Step two used to run a gateway in the browser and then call confirm_payment itself.
      Both halves are gone: the settlement is revoked from anon, and the only thing that
      may declare a payment successful is the paypal-capture function, which checks with
      PayPal first. Removing the client path is the fix -- leaving it would have meant a
      button that could only ever fail.                                                */

  /*  PayPal's buttons, mounted once the order exists.

      They are rendered by PayPal into a container we own rather than being a form we
      submit, which is why this is an effect. The flow:

        createOrder   -- tells PayPal what is being charged
        onApprove     -- the customer has approved, but nothing is settled yet
        capture       -- our server asks PayPal whether that is true, and only then
                         does confirm_payment allocate a key

      The browser is never the thing that decides a payment succeeded.               */
  useEffect(() => {
    // Pinned to a local so it stays narrowed inside the callbacks below.
    const config = paypalConfig;
    if (!config || stage !== "payment" || paypalMounted.current) return;

    let cancelled = false;

    void loadPayPal(config).then((sdk) => {
      const paypal = sdk as {
        Buttons: (options: Record<string, unknown>) => { render: (target: string) => void };
      };

      if (cancelled || !paypal?.Buttons) return;

      paypalMounted.current = true;

      paypal.Buttons({
        style: { layout: "vertical", shape: "pill", height: 48, label: "pay" },

        createOrder: (_data: unknown, actions: {
          order: { create: (o: Record<string, unknown>) => Promise<string> };
        }) =>
          actions.order.create({
            intent: "CAPTURE",
            purchase_units: [{
              custom_id: orderNumber,
              description: `${product?.name ?? "Plug-in"} × ${quantity}`,
              amount: {
                currency_code: config.currency,
                value: (total / 100).toFixed(2),
              },
            }],
          }),

        onApprove: async (data: { orderID: string }) => {
          setBusy(true);
          setError(null);

          /*  One server round trip does everything: capture with PayPal, check the
              amount against the order, allocate the keys. The browser used to call
              confirm_payment itself afterwards -- it no longer can, and no longer needs
              to, because the settled order comes back from here.                     */
          const captured = await captureServerSide(config, data.orderID, orderNumber);
          setBusy(false);

          if (!captured.ok || !captured.order) {
            setError(captured.error ?? "The payment could not be verified.");
            return;
          }

          const settled = captured.order as OrderView;

          setOrder(settled);
          setStage("done");
          void sendKeyEmail(settled.order.order_number, settled.customer.email);
        },

        onError: () => setError("PayPal could not complete the payment. Nothing has been charged."),
        onCancel: () => setError(null),
      }).render("#paypal-buttons");
    }).catch(() => setError("PayPal could not be loaded. Check your connection and try again."));

    return () => { cancelled = true; };
  }, [stage, orderNumber, total, quantity, product]);

  // The catalogue may still be loading; only call it unknown once it has arrived.
  if (!product && products.length > 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-24 sm:px-10">
        <p className="t-label text-muted-foreground">404</p>
        <h2 className="mt-3 mb-6 t-display">That plug-in is not for sale.</h2>
        <Button asChild variant="outline"><Link to="/plugins">Back to the plug-ins</Link></Button>
      </div>
    );
  }

  //====================================================================== done
  if (stage === "done" && order) {
    return (
      <section className="mx-auto w-full max-w-3xl px-6 py-16 sm:px-10">
        <div className="mb-8">
          <StepRail current={2} />
        </div>

        <Card className="animate-stamp">
          <CardContent className="space-y-6">
            <div>
              {/* The tick lands with the card, so the page reads as "done" before a
                  single word has been. */}
              <span className="mb-5 grid size-14 place-items-center rounded-full border-[3px] border-black bg-[#FFE500]">
                <Check className="size-7 text-black" strokeWidth={3} />
              </span>

              <Badge variant="mint" className="mb-4">Payment complete</Badge>
              <h1 className="t-display">Thank you.</h1>
              <p className="mt-2 t-body text-muted-foreground">
                Order <b className="text-foreground">{order.order.order_number}</b> —{" "}
                {money(order.order.total_cents, order.order.currency)} paid.
              </p>
            </div>

            <Separator />

            <div>
              <h2 className="t-title">
                {order.keys.length === 1 ? "Your licence key" : `Your ${order.keys.length} licence keys`}
              </h2>
              <p className="mt-1 mb-4 t-small text-muted-foreground">
                Save this somewhere. You can always find it again with your order number and email.
              </p>

              <KeyDelivery keys={order.keys} deliveries={order.deliveries} />
            </div>

            <div>
              <h3 className="mb-3 t-heading">Get the software</h3>
              <DownloadPanel
                slug={order.product.slug}
                orderNumber={order.order.order_number}
                email={order.customer.email}
                compact
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline"><Link to="/orders">Find my key later</Link></Button>
              <Button asChild variant="ghost"><Link to="/">Back to the store</Link></Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  //=================================================================== buying
  const current = stage === "details" ? 0 : 1;
  const offer = product ? saving(product) : null;
  const savedTotal = offer && product?.compare_at_cents
    ? (product.compare_at_cents - unit) * quantity
    : 0;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-6 py-12 sm:px-10 sm:py-16">
      <Link
        to={product ? `/plugins/${product.slug}` : "/plugins"}
        className="inline-flex items-center gap-2 t-small text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to the plug-in
      </Link>

      <h1 className="mt-5 mb-8 t-display">
        {stage === "details" ? "Your details" : "Payment"}
      </h1>

      <div className="mb-10">
        <StepRail current={current} />
      </div>

      <div className="grid items-start gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <Card>
          <CardContent className="space-y-6">
            {error && (
              <p
                role="alert"
                className="animate-step-in rounded-lg bg-destructive/10 px-4 py-3 t-body text-destructive"
              >
                {error}
              </p>
            )}

            {/*  Keyed on the stage so React tears the panel down and builds the next one,
                which is what lets the entrance animation run again. Without the key it is
                the same DOM with different children and nothing moves.                  */}
            {stage === "details" ? (
              <form key="details" onSubmit={startCheckout} className="animate-step-in space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email">Email — where the key is sent</Label>
                  <Input id="email" type="email" placeholder="you@example.com"
                         autoComplete="email"
                         value={email} onChange={(e) => setEmail(e.target.value)} required />
                  <p className="t-small text-muted-foreground">
                    Check it. The key goes here, and to this address only.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="name">Name (optional)</Label>
                  <Input id="name" placeholder="Your name" autoComplete="name"
                         value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>

                <div className="space-y-2">
                  <Label>Licences</Label>
                  <div className="flex items-center gap-4">
                    <div className="flex w-fit items-center overflow-hidden rounded-lg border-2 border-input">
                      <button
                        type="button"
                        className="grid size-11 place-items-center transition-colors hover:bg-secondary active:bg-secondary/70 disabled:opacity-35"
                        onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                        disabled={quantity <= 1}
                        aria-label="One fewer"
                      >
                        <Minus className="size-4" />
                      </button>

                      <span
                        key={quantity}
                        className="w-14 animate-pop text-center font-bold t-numeric"
                        aria-live="polite"
                      >
                        {quantity}
                      </span>

                      <button
                        type="button"
                        className="grid size-11 place-items-center transition-colors hover:bg-secondary active:bg-secondary/70 disabled:opacity-35"
                        onClick={() => setQuantity((q) => Math.min(25, q + 1))}
                        disabled={quantity >= 25}
                        aria-label="One more"
                      >
                        <Plus className="size-4" />
                      </button>
                    </div>

                    <span className="t-small text-muted-foreground">
                      {quantity === 1 ? "One machine" : `${quantity} machines`}
                    </span>
                  </div>
                </div>

                <Button className="w-full" disabled={busy}>
                  {busy
                    ? <><Loader2 className="animate-spin" /> Preparing</>
                    : "Continue to payment"}
                </Button>

                <p className="flex items-center justify-center gap-2 t-small text-muted-foreground">
                  <Lock className="size-3.5" aria-hidden="true" />
                  No account needed. Nothing is charged on this step.
                </p>
              </form>
            ) : (
              <div key="payment" className="animate-step-in space-y-5">
                {/*  What is actually taking the money, said plainly.

                    PayPal renders here once both halves of its configuration exist. Until
                    then this is the test gateway, and the panel says so rather than
                    dressing a simulation up as a payment page.                          */}
                {paypalConfig ? (
                  <div id="paypal-buttons" className="min-h-[150px]" />
                ) : (
                  /*  No provider, no payment form.

                      There used to be a card form here that accepted 4242 4242 4242 4242
                      and issued a real licence key. It has been removed rather than
                      relabelled: the settlement it relied on is now server-only, so the
                      form could no longer work -- and a checkout that takes card details
                      it cannot charge is worse than one that says it is not open yet. */
                  <div className="rounded-lg border-2 border-primary/35 bg-primary/8 p-5">
                    <p className="flex items-center gap-2 t-heading">
                      <CreditCard className="size-4 shrink-0" aria-hidden="true" />
                      Payments are not switched on yet
                    </p>
                    <p className="mt-2 t-small text-muted-foreground">
                      This shop is not taking money at the moment. Your order
                      &nbsp;<b className="t-numeric text-foreground">{orderNumber}</b>&nbsp;
                      has been kept, and no card details were asked for. In the meantime the
                      demo build is free and is the same binary buyers get.
                    </p>

                    <Button asChild variant="outline" className="mt-4">
                      <Link to={`/plugins/${product?.slug ?? ""}#download`}>
                        Get the demo build
                      </Link>
                    </Button>
                  </div>
                )}

                <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={() => { setStage("details"); setError(null); }}
                    className="inline-flex items-center gap-2 t-small text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ArrowLeft className="size-4" /> Change my details
                  </button>

                  <span className="t-small t-numeric text-muted-foreground">{orderNumber}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------------------------------ summary
            Sticky on desktop: the quantity control is in the left column and
            the number it changes is in the right one, so the two have to be on
            screen together or the feedback is invisible.                      */}
        <Card className="lg:sticky lg:top-8">
          <CardContent className="space-y-4">
            <p className="t-label text-muted-foreground">Order summary</p>

            <dl className="text-sm">
              {[
                [product?.name ?? "Plug-in", money(unit, currency)],
                ["Quantity", `× ${quantity}`],
                ["Delivery", "Instant — on screen + email"],
              ].map(([k, v], i) => (
                <div key={k}>
                  <div className="flex items-start justify-between gap-6 py-2.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                  {i < 2 && <Separator />}
                </div>
              ))}
            </dl>

            <Separator />

            <div className="flex items-baseline justify-between">
              <span className="font-bold">Total</span>
              <span key={total} className="animate-pop t-title t-numeric">
                {money(total, currency)}
              </span>
            </div>

            {savedTotal > 0 && (
              <p key={savedTotal} className="animate-pop text-right t-small text-emerald-700">
                You save {money(savedTotal, currency)}
              </p>
            )}

            <ul className="space-y-2 rounded-lg bg-muted p-4">
              {[
                "One-time payment",
                "Windows VST3 + Standalone",
                "Works offline once activated",
                "Commercial and live use included",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 t-small text-muted-foreground">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-700" strokeWidth={3} />
                  {line}
                </li>
              ))}
            </ul>

            <p className="flex items-center gap-2 t-small text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              Your key is shown on screen and emailed.
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

