import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !key) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env."
  );
}

/** No session handling: nobody logs in. Orders are looked up by number plus email. */
export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** What the offer is worth, worked out once so the page and the checkout cannot disagree
 *  about it. Returns null when there is no offer, which is the signal to render the price
 *  plainly rather than dressing it up. */
export function saving(product: {
  price_cents: number;
  compare_at_cents?: number | null;
  currency?: string;
}) {
  const was = product.compare_at_cents;

  if (!was || was <= product.price_cents) return null;

  const off = was - product.price_cents;

  return {
    wasText: money(was, product.currency),
    offText: money(off, product.currency),
    // Rounded, because "50% off" reads as a claim and "50.26% off" reads as a spreadsheet.
    percent: Math.round((off / was) * 100),
  };
}

//======================================================================== types
/** A product carries its own page. Nothing about any particular plug-in is written
 *  into the front end -- adding one is a row in the database, not a deploy. */
export interface Product {
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  version: string;
  price_cents: number;
  /** The "was" price. Null when the plug-in is not on offer, and the database will not
   *  accept one that is below price_cents -- a fake saving is not the page's to police. */
  compare_at_cents: number | null;
  currency: string;
  badge: string | null;
  image_path: string | null;
  /** Walkthrough clip. Null until one is published, and the section says so rather than
   *  rendering an player with nothing behind it. */
  demo_video_path: string | null;
  demo_poster_path: string | null;
  platform: string;
  /** `detail` says how the number was arrived at. Optional, so a product that has not
   *  been given one still renders a clean figure rather than an empty line. */
  highlights: { value: string; label: string; detail?: string | null }[];
  features: { n: string; title: string; body: string }[];
  specs: [string, string][];
  faq: { q: string; a: string }[];
  in_stock: boolean;
  is_active?: boolean;
  sort_order?: number;
  release_version?: string | null;
}

export interface Release {
  slug: string;
  version: string;
  platform: string;
  filename: string;
  url_path: string;
  size_bytes: number;
  sha256: string | null;
  notes: string | null;
  published_at: string;
}

export interface Review {
  author_name: string;
  author_role: string | null;
  rating: number;
  title: string | null;
  body: string;
  is_sample: boolean;
  created_at: string;
}

export interface ReviewSummary {
  count: number;
  average: number | null;
  /** True when any review on show is placeholder content. The page says so when it is:
   *  a made-up testimonial that ships quietly is a lie told to a buyer. */
  has_sample: boolean;
  rows: Review[];
}

export interface IssuedKey {
  key_code: string;
  status: string;
  assigned_at: string | null;
}

export interface Delivery {
  channel: "screen" | "email";
  status: "queued" | "sent" | "failed";
  recipient: string | null;
  detail: string | null;
  sent_at: string | null;
}

export interface OrderView {
  ok: true;
  order: {
    order_number: string;
    status: string;
    quantity: number;
    unit_cents: number;
    total_cents: number;
    currency: string;
    created_at: string;
    paid_at: string | null;
  };
  customer: { email: string; full_name: string | null };
  product: { name: string; version: string; slug: string };
  keys: IssuedKey[];
  deliveries: Delivery[];
}

export type Result<T> = T | { ok: false; error: string; available?: number };

export function failed<T>(r: Result<T>): r is { ok: false; error: string; available?: number } {
  return (r as { ok: boolean }).ok === false;
}

//======================================================================== calls
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  const { data, error } = await supabase.rpc(fn, args);

  if (error) return { ok: false, error: error.message };
  return data as Result<T>;
}

/** Everything listed in the store. */
export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await supabase.rpc("list_products", { p_include_drafts: false });
  if (error) throw error;
  return (data as Product[]) ?? [];
}

/** One product's page, or null if the slug is unknown or unlisted. */
export async function fetchProduct(slug: string): Promise<Product | null> {
  const { data, error } = await supabase.rpc("get_product", { p_slug: slug });
  if (error) throw error;
  return (data as Product) ?? null;
}

/** Approved reviews for one plug-in. Never throws: an empty shelf is better than a
 *  broken page, and the section hides itself when there is nothing to show. */
export async function fetchReviews(slug: string, limit = 6): Promise<ReviewSummary | null> {
  const { data, error } = await supabase.rpc("list_reviews", { p_slug: slug, p_limit: limit });
  if (error) return null;

  const result = data as ReviewSummary | null;
  return result && result.rows.length > 0 ? result : null;
}

export async function fetchRelease(slug: string): Promise<Release | null> {
  const { data, error } = await supabase.rpc("get_current_release", { p_slug: slug });
  if (error) return null;

  const result = data as (Release & { ok: boolean }) | null;
  return result?.ok ? result : null;
}

/*  Ask the server to email an order's keys.

    The browser never sees the mail provider's key and cannot name a recipient -- it says
    which order, and proves it may by supplying the address the order was placed with.
    The function sends to the address on the order regardless of what is passed in.

    Never awaited by anything blocking: the key is already on screen by the time this
    runs, so a mail failure must not stand between a customer and what they bought. The
    delivery row records the failure and the back office can resend.                  */
export async function sendKeyEmail(
  orderNumber: string,
  email: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${url}/functions/v1/send-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ order_number: orderNumber, email }),
    });

    return (await response.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "Could not reach the mail service." };
  }
}

/** Logged for the back office. Never awaited by anything the user is waiting on. */
export async function recordDownload(
  version: string,
  orderNumber?: string,
  email?: string
): Promise<void> {
  await supabase.rpc("record_download", {
    p_version: version,
    p_order_number: orderNumber ?? null,
    p_email: email ?? null,
    p_user_agent: navigator.userAgent,
  });
}

export interface CheckoutDraft {
  ok: true;
  order_number: string;
  total_cents: number;
  currency: string;
  quantity: number;
  product: { name: string; slug: string };
}

export function createCheckout(
  email: string,
  fullName: string,
  quantity: number,
  productSlug: string
): Promise<Result<CheckoutDraft>> {
  return rpc<CheckoutDraft>("create_checkout", {
    p_email: email,
    p_full_name: fullName,
    p_product_slug: productSlug,
    p_quantity: quantity,
  });
}

export function confirmPayment(
  orderNumber: string,
  providerRef: string,
  succeeded: boolean
): Promise<Result<OrderView>> {
  return rpc<OrderView>("confirm_payment", {
    p_order_number: orderNumber,
    p_provider: "mock",
    p_provider_ref: providerRef,
    p_succeeded: succeeded,
  });
}

export function lookupOrder(orderNumber: string, email: string): Promise<Result<OrderView>> {
  return rpc<OrderView>("get_order", {
    p_order_number: orderNumber,
    p_email: email,
    p_trusted: false,
  });
}
