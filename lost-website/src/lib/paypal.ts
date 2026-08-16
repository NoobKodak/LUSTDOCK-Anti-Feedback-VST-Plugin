/*  PayPal.

    Two things have to be true before this shop can take a real payment, and they are
    deliberately separate:

      VITE_PAYPAL_CLIENT_ID     -- public, safe in the browser. Renders the buttons.
      VITE_PAYPAL_CAPTURE_URL   -- an endpoint that captures the order *server-side*.

    The second is the one that matters, and the reason this file refuses to settle an
    order without it. PayPal's browser SDK will happily tell your page "approved" -- but
    that message comes from the customer's own machine, and anything a customer's machine
    says can be said by a customer who has opened the console. A licence key handed out on
    that word alone is a key given away.

    So the capture is done by something the customer cannot edit: a Supabase Edge Function
    holding the PayPal secret, which asks PayPal directly whether that order was really
    paid, and only then calls confirm_payment. Until that endpoint exists, isConfigured
    stays false and the checkout runs on the test gateway instead of pretending.       */

export interface PayPalConfig {
  clientId: string;
  captureUrl: string;
  currency: string;
}

const clientId = (import.meta.env.VITE_PAYPAL_CLIENT_ID as string | undefined) ?? "";

/*  The capture endpoint is derived, not configured.

    It used to be a second environment variable, which meant a deployment could be half
    set up -- a client id with no capture URL, or worse, a capture URL pointing somewhere
    else. It lives at a known path on the project's own Edge Functions host, so there is
    one thing to get right instead of two.                                             */
const captureUrl =
  `${(import.meta.env.VITE_SUPABASE_URL as string).replace(/\/+$/, "")}/functions/v1/paypal-capture`;

/** A client id is the whole configuration now. Without one, the checkout says so rather
 *  than dressing a simulation up as a payment page. */
export const paypalConfig: PayPalConfig | null =
  clientId ? { clientId, captureUrl, currency: "USD" } : null;

export const paypalPartiallyConfigured = false;

let loader: Promise<unknown> | null = null;

/** Loads the SDK once, however many times the checkout mounts. */
export function loadPayPal(config: PayPalConfig): Promise<unknown> {
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-paypal]");

    if (existing) {
      existing.addEventListener("load", () => resolve((window as never)["paypal"]));
      existing.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")));
      return;
    }

    const script = document.createElement("script");
    const params = new URLSearchParams({
      "client-id": config.clientId,
      currency: config.currency,
      intent: "capture",
      components: "buttons",
    });

    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.async = true;
    script.dataset.paypal = "true";
    script.onload = () => resolve((window as never)["paypal"]);
    script.onerror = () => reject(new Error("PayPal SDK failed to load"));

    document.head.appendChild(script);
  });

  return loader;
}

export interface CaptureResult {
  ok: boolean;
  /** The settled order, exactly as the lookup page would return it. Present on success:
   *  the server has already allocated the keys, so the browser has nothing left to do. */
  order?: unknown;
  provider_ref?: string;
  already_settled?: boolean;
  error?: string;
}

/*  Hands the approved order to our own server to be verified against PayPal.

    The browser does not decide whether money arrived, and does not settle the order --
    it cannot, because confirm_payment is revoked from anon. This returns the finished
    order or the reason it could not be finished.                                     */
export async function captureServerSide(
  config: PayPalConfig,
  paypalOrderId: string,
  orderNumber: string
): Promise<CaptureResult> {
  try {
    const response = await fetch(config.captureUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paypal_order_id: paypalOrderId, order_number: orderNumber }),
    });

    /*  Read the body whichever way it went. The function returns a specific, useful
        sentence on failure -- "the amount captured does not match the order", "quote
        this reference to support" -- and reporting the bare status code instead would
        throw all of that away at the moment the buyer most needs it.                 */
    const data = (await response.json().catch(() => null)) as CaptureResult | null;

    if (data) return data;

    return { ok: false, error: `The payment could not be verified (${response.status}).` };
  } catch {
    return {
      ok: false,
      error: "Could not reach the payment server. Your card has not been charged twice — check your order before retrying.",
    };
  }
}
