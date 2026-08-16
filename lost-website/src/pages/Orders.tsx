import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";

import { DownloadPanel } from "@/components/Download";
import { KeyDelivery } from "@/components/KeyDelivery";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label, Separator } from "@/components/ui/misc";
import { failed, lookupOrder, money, type OrderView } from "@/lib/supabase";

/** Order tracking. Number plus email, because the number alone must not be enough to
 *  read somebody else's keys — the database enforces that too. */
export function Orders() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOrder(null);

    const result = await lookupOrder(orderNumber.trim(), email.trim());
    setBusy(false);

    if (failed(result)) setError(result.error);
    else setOrder(result);
  };

  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-16 sm:px-10">
      {/*  The runner carries the page.

          There is no product shot here and nothing to look at -- it is a form for
          somebody who has lost something and is already slightly annoyed. So the mark
          does the work the artwork does elsewhere, set at the height of the whole text
          block rather than as an icon beside the heading.

          Decorative, so it is hidden from screen readers: the heading beside it already
          says what the page is, and "LOST logo" read aloud before it adds nothing.    */}
      <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-center sm:gap-10 sm:text-left">
        <img
          src="/brand/runlogo.webp"
          alt=""
          aria-hidden="true"
          className="w-[92px] shrink-0 animate-run-in sm:w-[124px]"
          draggable={false}
        />

        <div>
          <h1 className="t-hero uppercase">Find my key</h1>
          <p className="mt-4 max-w-[46ch] t-body text-muted-foreground">
            Lost your key, or never got the email? Enter the order number from your
            confirmation and the email you bought with.
          </p>
        </div>
      </div>

      <Card className="mt-10">
        <CardContent>
          <form onSubmit={submit} className="space-y-5">
            {error && (
              <p className="rounded-lg bg-destructive/10 px-4 py-3 t-body text-destructive">
                {error}
              </p>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ord">Order number</Label>
                <Input
                  id="ord"
                  placeholder="LD-XXXXXXXX"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value.toUpperCase())}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="eml">Email</Label>
                <Input
                  id="eml"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <Button className="w-full" disabled={busy}>
              <Search /> {busy ? "Looking up" : "Find my order"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {order && (
        <Card className="mt-6">
          <CardContent className="space-y-5">
            <dl className="text-sm">
              {[
                ["Order", order.order.order_number],
                ["Product", `${order.product.name} v${order.product.version}`],
                ["Paid", money(order.order.total_cents, order.order.currency)],
              ].map(([k, v], i) => (
                <div key={k}>
                  <div className="flex items-center justify-between gap-6 py-2.5">
                    <dt className="t-small text-muted-foreground">{k}</dt>
                    <dd className="font-medium">{v}</dd>
                  </div>
                  {i < 2 && <Separator />}
                </div>
              ))}
            </dl>

            {order.keys.length > 0 ? (
              <>
                <h2 className="pt-2 t-title">
                  {order.keys.length === 1 ? "Your licence key" : "Your licence keys"}
                </h2>

                <KeyDelivery keys={order.keys} deliveries={order.deliveries} />

                <div className="pt-2">
                  <h3 className="mb-3 t-heading">Download the software</h3>
                  <DownloadPanel
                    slug={order.product.slug}
                    orderNumber={order.order.order_number}
                    email={order.customer.email}
                    compact
                  />
                </div>
              </>
            ) : (
              <p className="t-body text-muted-foreground">
                This order has no keys against it yet. If you have just paid, give it a
                moment and refresh.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

