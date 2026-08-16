import { useState, type FormEvent } from "react";
import { Search, Monitor, Loader2 } from "lucide-react";

import { DownloadPanel } from "@/components/Download";
import { KeyDelivery } from "@/components/KeyDelivery";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label, Separator } from "@/components/ui/misc";
import {
  fetchActivations, failed, lookupOrder, money, releaseActivation,
  type ActivatedMachine, type OrderView,
} from "@/lib/supabase";

/** Order tracking. Number plus email, because the number alone must not be enough to
 *  read somebody else's keys — the database enforces that too. */
export function Orders() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);

  const [machines, setMachines] = useState<ActivatedMachine[]>([]);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [released, setReleased] = useState<string | null>(null);

  const loadMachines = async (ord: string, mail: string) => {
    const result = await fetchActivations(ord, mail);
    setMachines(failed(result) ? [] : result.rows);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOrder(null);
    setMachines([]);
    setReleased(null);

    const ord = orderNumber.trim();
    const mail = email.trim();
    const result = await lookupOrder(ord, mail);

    if (failed(result)) {
      setBusy(false);
      setError(result.error);
      return;
    }

    setOrder(result);
    await loadMachines(ord, mail);
    setBusy(false);
  };

  /*  Frees a seat so the licence can be activated somewhere else.

      No confirmation dialog: this is reversible in seconds by activating again, and the
      people who reach for it are usually locked out and slightly cross already. A modal
      between them and the fix would be one more thing in the way.                    */
  const release = async (machine: ActivatedMachine) => {
    setReleasing(machine.activation_id);
    setError(null);
    setReleased(null);

    const result = await releaseActivation(
      orderNumber.trim(), email.trim(), machine.activation_id
    );

    setReleasing(null);

    if (failed(result)) {
      setError(result.error);
      return;
    }

    setReleased(machine.machine_name);
    await loadMachines(orderNumber.trim(), email.trim());
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

      {/*  Where the licence is running, and how to take it off a computer.

          This is the whole reason seat limits are tolerable. A key allows three machines,
          and the case that would otherwise generate a support email every time is the
          laptop that was sold, stolen or simply died -- it cannot release its own seat,
          so releasing has to be possible from here, with nothing but the order number
          and the email the order was bought with.                                     */}
      {order && order.keys.length > 0 && (
        <Card className="mt-6">
          <CardContent className="space-y-5">
            <div>
              <h2 className="t-title">Your computers</h2>
              <p className="mt-1 t-small text-muted-foreground">
                {machines.length === 0
                  ? "This licence is not activated on any computer yet."
                  : `Activated on ${machines.length} of ${machines[0].seat_limit}. ` +
                    "Release one to free it up for another machine — you can always activate it again."}
              </p>
            </div>

            {released && (
              <p className="rounded-lg bg-duck-mint/15 px-4 py-3 t-small text-emerald-700">
                <b>{released}</b> released. That seat is free — activate the plug-in on
                the computer you want to use it on.
              </p>
            )}

            {machines.length > 0 && (
              <ul className="space-y-2">
                {machines.map((m) => (
                  <li
                    key={m.activation_id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-foreground/10 p-4"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold">{m.machine_name}</span>
                        <span className="block t-small text-muted-foreground">
                          {m.key_code} &middot; activated{" "}
                          {new Date(m.activated_at).toLocaleDateString()}
                        </span>
                      </span>
                    </span>

                    <Button
                      variant="outline"
                      onClick={() => void release(m)}
                      disabled={releasing !== null}
                    >
                      {releasing === m.activation_id
                        ? <><Loader2 className="animate-spin" /> Releasing</>
                        : "Release"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <p className="t-small text-muted-foreground">
              Changed computer, or reinstalled Windows? Release the old one here. If the
              machine is gone and you cannot see it listed, contact us with your order
              number.
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

