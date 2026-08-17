import { useCallback, useEffect, useRef, useState } from "react";

import { megabytes } from "../components/Download";
import { money, supabase } from "../lib/supabase";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

/*  Store back office.

    Gated by the shared token in admin_tokens. Demo-grade and deliberately so -- it keeps
    the RPCs from being open to anyone who finds the project URL, and it is not real
    authentication. Before anyone but the owner can reach this, move it to Supabase Auth
    and check a role claim inside the functions.
*/

const TOKEN_KEY = "lost.admin.token";

type Tab =
  | "dashboard" | "plugins" | "reviews" | "orders" | "keys" | "activations"
  | "customers" | "deliveries" | "releases" | "import" | "audit";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "plugins", label: "Plug-ins" },
  { id: "reviews", label: "Reviews" },
  { id: "orders", label: "Orders" },
  { id: "keys", label: "Keys" },
  { id: "activations", label: "Activations" },
  { id: "customers", label: "Customers" },
  { id: "deliveries", label: "Deliveries" },
  { id: "releases", label: "Releases" },
  { id: "import", label: "Import stock" },
  { id: "audit", label: "Audit log" },
];

interface Overview {
  keys: { unused: number; used: number; revoked: number; total: number };
  orders: { paid: number; pending: number; failed: number; total: number };
  revenue_cents: number;
  customers: number;
  deliveries: { sent: number; queued: number; failed: number };
}

interface OrderRow {
  order_number: string; status: string; quantity: number; total_cents: number;
  currency: string; created_at: string; paid_at: string | null;
  email: string; full_name: string | null; product: string; keys_issued: number;
}

interface KeyRow {
  key_code: string; status: string; serial: number | null;
  created_at: string; assigned_at: string | null;
  order_number: string | null; email: string | null;
}

interface CustomerRow {
  email: string; full_name: string | null; created_at: string;
  paid_orders: number; spent_cents: number; licences: number; last_order_at: string | null;
}

interface DeliveryRow {
  channel: string; status: string; recipient: string | null; detail: string | null;
  created_at: string; sent_at: string | null; order_number: string; key_code: string | null;
}

interface ReleaseRow {
  product: string; product_slug: string;
  version: string; platform: string; channel: string; filename: string; url_path: string;
  size_bytes: number; sha256: string | null; notes: string | null;
  is_current: boolean; published_at: string; download_count: number;
}

interface ProductRow {
  slug: string; name: string; tagline: string | null; description: string | null;
  version: string; price_cents: number; compare_at_cents: number | null;
  currency: string; is_active: boolean;
  sort_order: number; badge: string | null; image_path: string | null; platform: string;
  demo_video_path: string | null; demo_poster_path: string | null;
  highlights: unknown; features: unknown; specs: unknown; faq: unknown;
  keys_unused: number; keys_sold: number; paid_orders: number;
  revenue_cents: number; release_version: string | null;
}

interface ActivationRow {
  key_code: string; product: string; seat_limit: number;
  email: string | null; order_number: string | null;
  live_seats: number; binds: number; auto_released: number;
  last_seen_at: string;
  machines: { id: string; name: string; activated_at: string }[];
}

interface ReviewRow {
  id: string; slug: string; product: string;
  author_name: string; author_role: string | null; rating: number;
  title: string | null; body: string;
  is_approved: boolean; is_sample: boolean; created_at: string;
}

interface AuditRow {
  action: string; target: string | null; detail: Record<string, unknown>; created_at: string;
}

interface SeriesRow { day: string; revenue_cents: number; orders: number }

interface OrderDetail {
  order: OrderRow;
  payments: { provider: string; provider_ref: string | null; amount_cents: number; status: string; created_at: string; settled_at: string | null }[];
  keys: { key_code: string; status: string; assigned_at: string | null }[];
  deliveries: DeliveryRow[];
  downloads: { created_at: string; version: string; user_agent: string | null }[];
}

//========================================================================= helpers
function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** Any row shape: the caller passes whichever table is on screen, and the columns are
 *  taken from the first row rather than declared per type. */
function downloadCsv<T extends object>(filename: string, rows: T[]) {
  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]) as (keyof T)[];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    columns.join(","),
    ...rows.map((r) => columns.map((c) => escape(r[c])).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Thirty bars, no chart library. Anything more would be a dependency for a sparkline. */
function Sparkline({ series }: { series: SeriesRow[] }) {
  const peak = Math.max(1, ...series.map((d) => d.revenue_cents));

  return (
    <div className="spark">
      {series.map((d) => (
        <div
          key={d.day}
          className={`spark-bar ${d.revenue_cents > 0 ? "is-live" : ""}`}
          style={{ height: `${Math.max(2, (d.revenue_cents / peak) * 100)}%` }}
          title={`${d.day} — ${money(d.revenue_cents)} from ${d.orders} order(s)`}
        />
      ))}
    </div>
  );
}

/*  How many rows the importer will actually try.

    Counts lines that look like key data rather than lines in the file, so the button can
    say "Import 5000 keys" instead of the meaningless character count of a 200 KB paste.
    A header row and blank lines are skipped here exactly as the server skips them, so
    the number on the button is the number that will be attempted.                     */
function countKeyRows(csv: string): number {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && /[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/.test(line))
    .length;
}

/*  One pager for every list.

    Shows the range actually on screen against the true total, so "26–50 of 312" answers
    both "where am I" and "how much is there" -- a bare next/previous pair answers
    neither. Disabled rather than hidden at the ends: a control that vanishes moves
    everything next to it.                                                            */
function Pager({
  page, pageSize, total, busy, onPage,
}: {
  page: number; pageSize: number; total: number; busy: boolean;
  onPage: (next: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="pager">
      <span className="small muted">
        {total === 0 ? "No rows" : `${from}–${to} of ${total}`}
      </span>

      <div className="pager-buttons">
        <button
          className="copy-btn"
          onClick={() => onPage(page - 1)}
          disabled={busy || page <= 0}
        >
          Previous
        </button>
        <span className="small muted">Page {page + 1} of {pages}</span>
        <button
          className="copy-btn"
          onClick={() => onPage(page + 1)}
          disabled={busy || page + 1 >= pages}
        >
          Next
        </button>
      </div>
    </div>
  );
}

//============================================================================ page
export function Admin() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [entry, setEntry] = useState("");
  const [tab, setTab] = useState<Tab>("dashboard");

  const [overview, setOverview] = useState<Overview | null>(null);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [activations, setActivations] = useState<ActivationRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [detail, setDetail] = useState<OrderDetail | null>(null);

  const [keyFilter, setKeyFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [deliveryFilter, setDeliveryFilter] = useState("queued");

  /*  Two values, not one.

      `search` is what is in the box and updates on every keystroke; `query` is what the
      server has been asked for and lags a third of a second behind. They were the same
      value, and `refresh` lists it as a dependency -- so typing an eight-character order
      number fired all eight admin queries eight times over. The box stays responsive
      because it renders from `search`; the database hears about it once.             */
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 320);
    return () => clearTimeout(timer);
  }, [search]);

  /*  Paging state, per list. Reset to the first page whenever the thing being asked for
      changes -- staying on page 7 of a search that now returns four rows shows an empty
      table and looks like a bug.                                                      */
  const PAGE = 25;
  const [orderPage, setOrderPage] = useState(0);
  const [keyPage, setKeyPage] = useState(0);
  const [orderTotal, setOrderTotal] = useState(0);
  const [keyTotal, setKeyTotal] = useState(0);

  const [reviewFilter, setReviewFilter] = useState("");
  const [csv, setCsv] = useState("");

  const [dragging, setDragging] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /*  Reads a dropped or chosen file into the textarea.

      Everything is checked before the contents are shown: the wrong file dropped by
      accident should say so rather than filling the box with binary. The 5 MB ceiling is
      well past a 5,000-key CSV (~200 KB) and well short of anything that would lock the
      browser up while it renders.                                                     */
  const takeFile = async (file?: File) => {
    if (!file) return;

    setError(null);
    setMessage(null);

    if (file.size > 5 * 1024 * 1024) {
      setError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The importer takes files up to 5 MB.`);
      return;
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith(".csv") && !name.endsWith(".txt")) {
      setError(`${file.name} is not a .csv or .txt file.`);
      return;
    }

    try {
      const text = await file.text();
      const rows = countKeyRows(text);

      if (rows === 0) {
        setError(`${file.name} has no rows that look like licence keys. Expected "serial,key" per line.`);
        return;
      }

      setCsv(text);
      setFileNote(`${file.name} — ${rows.toLocaleString()} key${rows === 1 ? "" : "s"} found`);
    } catch {
      setError(`Could not read ${file.name}.`);
    }
  };
  const [draft, setDraft] = useState<ProductRow | null>(null);

  /* Empty means the whole store. Every list, the dashboard and the importer all read
     this one value, so switching product switches the entire back office at once
     rather than each tab keeping its own idea of what is being looked at. */
  const [scope, setScope] = useState("");
  const [importSlug, setImportSlug] = useState("");

  /*  Back to page one whenever the question changes. Staying on page 7 of a search that
      now returns four rows renders an empty table, which reads as a broken filter.   */
  useEffect(() => {
    setOrderPage(0);
    setKeyPage(0);
  }, [query, scope, keyFilter, orderFilter]);

  const [pending, setPending] = useState<
    { title: string; body: string; confirm: string; run: () => void } | null
  >(null);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);

  const call = useCallback(
    async (fn: string, args: Record<string, unknown> = {}) => {
      const { data, error: rpcError } = await supabase.rpc(fn, { p_token: token, ...args });
      if (rpcError) return { ok: false as const, error: rpcError.message };
      return data as { ok: boolean; error?: string; [k: string]: any };
    },
    [token]
  );

  const refresh = useCallback(async () => {
    if (!token) return;

    setBusy(true);
    setError(null);

    const slug = scope || null;
    const o = await call("admin_overview", { p_slug: slug });

    if (!o.ok) {
      setAuthFailed(true);
      setError(o.error ?? "Not authorised.");
      setBusy(false);
      return;
    }

    setAuthFailed(false);
    setOverview(o as unknown as Overview);

    const [s, ord, k, cust, del, rel, prod, rev, act, aud] = await Promise.all([
      call("admin_sales_series", { p_days: 30, p_slug: slug }),
      call("admin_orders", {
        p_limit: PAGE, p_slug: slug, p_search: query || null,
        p_status: orderFilter || null, p_offset: orderPage * PAGE,
      }),
      call("admin_keys", {
        p_status: keyFilter || null, p_limit: PAGE, p_slug: slug,
        p_search: query || null, p_offset: keyPage * PAGE,
      }),
      call("admin_customers", { p_search: query || null, p_limit: 200 }),
      call("admin_deliveries", { p_status: deliveryFilter || null, p_limit: 300, p_slug: slug }),
      call("admin_releases", { p_slug: slug }),
      call("admin_product_stats"),
      call("admin_reviews"),
      call("admin_activations", { p_search: query || null, p_limit: 200 }),
      call("admin_audit_log", { p_limit: 200 }),
    ]);

    if (s.ok) setSeries(s.rows ?? []);
    if (ord.ok) { setOrders(ord.rows ?? []); setOrderTotal(ord.total ?? 0); }
    if (k.ok) { setKeys(k.rows ?? []); setKeyTotal(k.total ?? 0); }
    if (cust.ok) setCustomers(cust.rows ?? []);
    if (del.ok) setDeliveries(del.rows ?? []);
    if (rel.ok) setReleases(rel.rows ?? []);
    if (rev.ok) setReviews(rev.rows ?? []);
    if (act.ok) setActivations(act.rows ?? []);
    if (aud.ok) setAudit(aud.rows ?? []);

    if (prod.ok) {
      const rows: ProductRow[] = prod.rows ?? [];
      setProducts(rows);

      // Keep editing whatever was open; fall back to the scoped product, then the first.
      setDraft((current) =>
        rows.find((r) => r.slug === current?.slug)
        ?? rows.find((r) => r.slug === scope)
        ?? rows[0]
        ?? null
      );

      if (!importSlug && rows.length > 0) setImportSlug(scope || rows[0].slug);
    }

    setBusy(false);
    // `query` rather than `search`: the debounced value, so this runs once a pause
    // rather than once a keypress.
  }, [call, token, keyFilter, orderFilter, deliveryFilter, query, scope, importSlug,
      orderPage, keyPage]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: string, args: Record<string, unknown>, success: string) => {
    const r = await call(fn, args);

    if (r.ok) {
      setMessage(success);
      setError(null);
      void refresh();
    } else {
      setError(r.error ?? "That did not work.");
      setMessage(null);
    }
  };

  /*  Destructive work asks first.

      Revoking a key, refunding an order and deleting a product all fired on the first
      click, next to ordinary buttons, in a dense table where the wrong row is one pixel
      away. The dialog states what will happen to which record rather than asking "are
      you sure", because the useful question is "sure about *what*".                  */
  /*  Flush the email queue.

      Goes to the Edge Function rather than an RPC, because that is where the mail
      provider's key lives. Reports per-order results so a partial failure is legible --
      "3 sent, 1 failed" with the reason, rather than a single unhelpful outcome for the
      whole batch.                                                                     */
  const [draining, setDraining] = useState(false);

  const drainDeliveries = async () => {
    setDraining(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/send-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drain: true, token }),
      });

      const result = await response.json() as {
        ok: boolean; error?: string; processed?: number;
        results?: { order: string; ok: boolean; error?: string }[];
      };

      if (!result.ok) {
        setError(result.error ?? "The mail service refused that.");
      } else if (!result.processed) {
        setMessage("Nothing was waiting to be sent.");
      } else {
        const sent = result.results?.filter((r) => r.ok).length ?? 0;
        const failed = result.results?.filter((r) => !r.ok) ?? [];

        setMessage(`${sent} sent.${failed.length ? ` ${failed.length} failed.` : ""}`);

        if (failed.length) {
          setError(failed.map((f) => `${f.order}: ${f.error}`).join(" · "));
        }
      }
    } catch {
      setError("Could not reach the mail service.");
    }

    setDraining(false);
    void refresh();
  };

  const confirmAct = (
    prompt: { title: string; body: string; confirm: string },
    fn: string,
    args: Record<string, unknown>,
    success: string
  ) => setPending({ ...prompt, run: () => void act(fn, args, success) });

  /*  The lists arrive already searched and already paged.

      They used to be filtered again here, over whatever slice had been fetched. That is
      wrong twice: the row you want may not be in the slice at all, so the box reports
      "nothing found" for a record that plainly exists -- and re-filtering a server page
      silently drops rows out of a page that is supposed to hold twenty-five, making the
      pager lie about what is on screen.                                              */
  const filteredOrders = orders;
  const filteredKeys = keys;

  /*  Reviews are filtered here rather than on the server: there will never be enough of
      them to page, and moderation means flicking between "what is live" and "what is
      waiting" constantly. A round trip for that would be slower than it is worth.    */
  const visibleReviews = reviews.filter((r) =>
    reviewFilter === "shown" ? r.is_approved
    : reviewFilter === "hidden" ? !r.is_approved
    : reviewFilter === "sample" ? r.is_sample
    : true);

  //=================================================================== sign in
  if (!token || authFailed) {
    return (
      <section className="admin-shell section">
        <div className="shell" style={{ maxWidth: 460 }}>
          <p className="eyebrow">Store admin</p>
          <h2 style={{ marginBottom: 20 }}>Sign in</h2>

          <div className="panel">
            {error && <div className="notice notice-bad">{error}</div>}

            <div className="field">
              <label htmlFor="tok">Admin token</label>
              <input
                id="tok" className="input" type="password" placeholder="lostduck_..."
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  localStorage.setItem(TOKEN_KEY, entry.trim());
                  setAuthFailed(false);
                  setToken(entry.trim());
                }}
              />
            </div>

            <button
              className="btn btn-mint btn-block"
              onClick={() => {
                localStorage.setItem(TOKEN_KEY, entry.trim());
                setAuthFailed(false);
                setToken(entry.trim());
              }}
            >
              Enter
            </button>

            <p className="small muted" style={{ marginTop: 16 }}>
              Demo-grade access control: a shared token, hashed in the database. Replace
              with Supabase Auth before anyone else can reach this page.
            </p>
          </div>
        </div>
      </section>
    );
  }

  //=================================================================== console
  return (
    <section className="admin-shell section">
      <div className="shell">
        <div className="admin-bar">
          <div style={{ marginRight: "auto" }}>
            <p className="eyebrow">Store admin</p>
            <h2>Back office</h2>
          </div>

          {/* One switch for the whole back office. */}
          <select
            className="input admin-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            title="Which plug-in these figures are for"
          >
            <option value="">All plug-ins</option>
            {products.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}{p.is_active ? "" : " (draft)"}
              </option>
            ))}
          </select>

          <input
            className="input admin-search"
            placeholder="Search orders, keys, customers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <button className="btn btn-ghost" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Refreshing" : "Refresh"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken(""); setOverview(null); }}
          >
            Sign out
          </button>
        </div>

        {message && <div className="notice notice-good">{message}</div>}
        {error && <div className="notice notice-bad">{error}</div>}

        {overview && (
          <div className="admin-grid">
            <div className="panel panel-tight">
              <p className="eyebrow">Revenue</p>
              <div className="metric" style={{ color: "var(--orange-hot)" }}>{money(overview.revenue_cents)}</div>
              <p className="small muted">{overview.orders.paid} paid orders</p>
            </div>
            <div className="panel panel-tight">
              <p className="eyebrow">Keys unused</p>
              <div className="metric" style={{ color: "var(--mint)" }}>{overview.keys.unused}</div>
              <p className="small muted">{overview.keys.used} sold · {overview.keys.revoked} revoked</p>
            </div>
            <div className="panel panel-tight">
              <p className="eyebrow">Customers</p>
              <div className="metric">{overview.customers}</div>
              <p className="small muted">{overview.orders.failed} failed orders</p>
            </div>
            <div className="panel panel-tight">
              <p className="eyebrow">Emails queued</p>
              <div className="metric" style={{ color: overview.deliveries.queued > 0 ? "var(--orange-hot)" : "var(--mint)" }}>
                {overview.deliveries.queued}
              </div>
              <p className="small muted">{overview.deliveries.sent} delivered</p>
            </div>
          </div>
        )}

        {/*  Rail on the left, work on the right.

            Ten destinations as a wrapping strip of pills ran to two rows and buried the
            selected one among them. A column states the order of the back office once
            and keeps it still while the panel beside it changes.                      */}
        <div className="admin-layout">
          <nav className="admin-side" aria-label="Back office sections">
            <p className="admin-side-heading">Sections</p>

            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "is-on" : ""}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="admin-main">

        {/* ------------------------------------------------------ dashboard */}
        {tab === "dashboard" && overview && (
          <div className="checkout">
            <div className="panel">
              <h3 style={{ marginBottom: 4 }}>Revenue, last 30 days</h3>
              <p className="small muted">
                {money(series.reduce((sum, d) => sum + d.revenue_cents, 0))} across{" "}
                {series.reduce((sum, d) => sum + d.orders, 0)} orders.
              </p>
              <Sparkline series={series} />

              <h3 style={{ margin: "26px 0 10px" }}>Stock</h3>
              <div className="meter">
                <span
                  style={{ width: `${(overview.keys.used / Math.max(1, overview.keys.total)) * 100}%` }}
                />
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                {overview.keys.used} of {overview.keys.total} sold &middot;{" "}
                {overview.keys.unused} left
              </p>

              {overview.keys.unused < 20 && (
                <div className="notice notice-bad" style={{ marginTop: 16 }}>
                  Only {overview.keys.unused} keys left. Mint more with{" "}
                  <span className="mono">LostDuckKeyGen 5000 &gt; keys.csv</span> and load
                  them on the Import stock tab.
                </div>
              )}
            </div>

            <div className="panel">
              <h3 style={{ marginBottom: 12 }}>Needs attention</h3>

              {overview.deliveries.queued > 0 ? (
                <div className="notice notice-bad">
                  <b>{overview.deliveries.queued} emails have never been sent.</b> No mail
                  provider is connected, so each queued row is a customer who only has
                  their key if they kept the confirmation page.
                </div>
              ) : (
                <div className="notice notice-good">Nothing waiting in the delivery queue.</div>
              )}

              {overview.orders.pending > 0 && (
                <div className="notice notice-info">
                  {overview.orders.pending} order(s) started and never paid. Normal &mdash;
                  people abandon checkouts. No stock is held by them.
                </div>
              )}

              <h3 style={{ margin: "22px 0 10px" }}>Latest activity</h3>
              <ul className="feed">
                {audit.slice(0, 6).map((a, i) => (
                  <li key={i}>
                    <span className="mono">{a.action}</span> {a.target}
                    <span className="muted small"> · {when(a.created_at)}</span>
                  </li>
                ))}
                {audit.length === 0 && <li className="muted small">No admin actions yet.</li>}
              </ul>
            </div>
          </div>
        )}

        {/* --------------------------------------------------------- orders */}
        {tab === "orders" && (
          <>
            <div className="toolbar">
              <select
                className="input"
                style={{ maxWidth: 190 }}
                value={orderFilter}
                onChange={(e) => setOrderFilter(e.target.value)}
                aria-label="Filter orders by status"
              >
                <option value="">Every status</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
                <option value="refunded">Refunded</option>
              </select>

              <span className="small muted">{orderTotal} matching</span>

              {/*  Exports what is on screen, and says so. An "Export CSV" that quietly
                  writes 25 of 312 rows is worse than no export at all.               */}
              <button
                className="btn btn-ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => downloadCsv("orders.csv", filteredOrders)}
                disabled={filteredOrders.length === 0}
                title="Exports the rows on this page"
              >
                Export this page
              </button>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Order</th><th>Status</th><th>Customer</th><th>Qty</th>
                    <th>Total</th><th>Keys</th><th>Placed</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.length === 0 && (
                    <tr><td colSpan={8} className="muted">No orders.</td></tr>
                  )}
                  {filteredOrders.map((o) => (
                    <tr key={o.order_number}>
                      <td>{o.order_number}</td>
                      <td><span className={`pill pill-${o.status}`}>{o.status}</span></td>
                      <td>{o.email}</td>
                      <td>{o.quantity}</td>
                      <td>{money(o.total_cents, o.currency)}</td>
                      <td>{o.keys_issued}</td>
                      <td>{when(o.created_at)}</td>
                      <td>
                        <button
                          className="copy-btn"
                          onClick={async () => {
                            const r = await call("admin_order_detail", { p_order: o.order_number });
                            if (r.ok) setDetail(r as unknown as OrderDetail);
                            else setError(r.error ?? "Could not open that order.");
                          }}
                        >
                          OPEN
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager
              page={orderPage} pageSize={PAGE} total={orderTotal} busy={busy}
              onPage={setOrderPage}
            />
          </>
        )}

        {/* ----------------------------------------------------------- keys */}
        {tab === "keys" && (
          <>
            <div className="toolbar">
              <div className="tabs" style={{ margin: 0 }}>
                {["", "unused", "used", "revoked"].map((s) => (
                  <button key={s || "all"} className={keyFilter === s ? "is-on" : ""} onClick={() => setKeyFilter(s)}>
                    {s || "all"}
                  </button>
                ))}
              </div>
              <span className="small muted" style={{ marginLeft: "auto" }}>{keyTotal} matching</span>
              <button
                className="btn btn-ghost"
                onClick={() => downloadCsv("keys.csv", filteredKeys)}
                disabled={filteredKeys.length === 0}
                title="Exports the rows on this page"
              >
                Export this page
              </button>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Key</th><th>Status</th><th>Serial</th><th>Order</th><th>Customer</th><th>Assigned</th><th></th></tr>
                </thead>
                <tbody>
                  {filteredKeys.length === 0 && <tr><td colSpan={7} className="muted">Nothing here.</td></tr>}
                  {filteredKeys.map((k) => (
                    <tr key={k.key_code}>
                      <td style={{ color: k.status === "unused" ? "var(--paper)" : "var(--steel)" }}>{k.key_code}</td>
                      <td><span className={`pill pill-${k.status}`}>{k.status}</span></td>
                      <td>{k.serial ?? "—"}</td>
                      <td>{k.order_number ?? "—"}</td>
                      <td>{k.email ?? "—"}</td>
                      <td>{k.assigned_at ? new Date(k.assigned_at).toLocaleDateString() : "—"}</td>
                      <td>
                        {k.status !== "used" && (
                          <button
                            className="copy-btn"
                            onClick={() => {
                              const next = k.status === "revoked" ? "unused" : "revoked";

                              confirmAct(
                                next === "revoked"
                                  ? {
                                      title: "Revoke this key?",
                                      body: `${k.key_code} will stop working and cannot be sold. It can be restored afterwards.`,
                                      confirm: "Revoke it",
                                    }
                                  : {
                                      title: "Put this key back on sale?",
                                      body: `${k.key_code} returns to stock and may be issued to the next buyer.`,
                                      confirm: "Restore it",
                                    },
                                "admin_set_key_status",
                                { p_key: k.key_code, p_status: next },
                                `${k.key_code} is now ${next}.`
                              );
                            }}
                          >
                            {k.status === "revoked" ? "RESTORE" : "REVOKE"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager
              page={keyPage} pageSize={PAGE} total={keyTotal} busy={busy}
              onPage={setKeyPage}
            />
          </>
        )}

        {/* --------------------------------------------------- activations */}
        {tab === "activations" && (
          <>
            <div className="notice notice-info">
              Each licence runs on up to its seat limit. The column to watch is{" "}
              <b>binds</b> &mdash; how many machines a key has <i>ever</i> been on. A key
              sitting at 3 of 3 is somebody with a studio, a stage laptop and a spare. A
              key bound to fourteen machines is a key somebody has published.
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Key</th><th>Customer</th><th>Seats</th><th>Binds</th>
                    <th>Machines</th><th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {activations.length === 0 && (
                    <tr><td colSpan={6} className="muted">
                      Nothing activated yet. Keys appear here once a customer activates one.
                    </td></tr>
                  )}
                  {activations.map((a) => (
                    <tr key={a.key_code}>
                      <td className="mono">{a.key_code}</td>
                      <td>
                        {a.email ?? "—"}
                        {a.order_number && <div className="small muted">{a.order_number}</div>}
                      </td>
                      <td>
                        <span className={`pill ${a.live_seats >= a.seat_limit ? "pill-unused" : "pill-used"}`}>
                          {a.live_seats} / {a.seat_limit}
                        </span>
                      </td>
                      <td>
                        {/*  Flagged once a key has been bound to more machines than the
                            seat limit plus its grace allowance -- the point past which
                            re-installs stop being a plausible explanation.            */}
                        <span style={{ color: a.binds > a.seat_limit + 2 ? "var(--destructive)" : undefined }}>
                          {a.binds}
                        </span>
                        {a.auto_released > 0 && (
                          <div className="small muted">{a.auto_released} auto-freed</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                        {a.machines.length === 0 && <span className="muted">none</span>}
                        {a.machines.map((m) => (
                          <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 8 }}>
                            <span>{m.name}</span>
                            <button
                              className="copy-btn"
                              onClick={() => confirmAct(
                                {
                                  title: "Release this seat?",
                                  body: `${m.name} will stop running ${a.key_code}. The customer can activate it again, and this frees a seat for another machine.`,
                                  confirm: "Release it",
                                },
                                "admin_release_activation", { p_id: m.id },
                                `${m.name} released.`
                              )}
                            >
                              release
                            </button>
                          </span>
                        ))}
                      </td>
                      <td>{when(a.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ------------------------------------------------------ customers */}
        {tab === "customers" && (
          <>
            <div className="toolbar">
              <span className="small muted">{customers.length} customers</span>
              <button className="btn btn-ghost" onClick={() => downloadCsv("customers.csv", customers)}>
                Export CSV
              </button>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Email</th><th>Name</th><th>Paid orders</th><th>Licences</th><th>Spent</th><th>Last order</th><th>Joined</th></tr>
                </thead>
                <tbody>
                  {customers.length === 0 && <tr><td colSpan={7} className="muted">No customers yet.</td></tr>}
                  {customers.map((c) => (
                    <tr key={c.email}>
                      <td>{c.email}</td>
                      <td>{c.full_name ?? "—"}</td>
                      <td>{c.paid_orders}</td>
                      <td>{c.licences}</td>
                      <td style={{ color: "var(--mint)" }}>{money(c.spent_cents)}</td>
                      <td>{when(c.last_order_at)}</td>
                      <td>{new Date(c.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ----------------------------------------------------- deliveries */}
        {tab === "deliveries" && (
          <>
            <div className="notice notice-info">
              Keys are emailed by the <span className="mono">send-keys</span> function on
              Supabase. A row stuck at <b>queued</b> means the send has not run or did not
              finish &mdash; <b>Send queued now</b> retries every one of them, and a
              failure records the provider&rsquo;s own reason in the row.
            </div>

            <div className="toolbar">
              <div className="tabs" style={{ margin: 0 }}>
                {["", "queued", "sent", "failed"].map((s) => (
                  <button key={s || "all"} className={deliveryFilter === s ? "is-on" : ""} onClick={() => setDeliveryFilter(s)}>
                    {s || "all"}
                  </button>
                ))}
              </div>

              <button
                className="btn btn-mint"
                style={{ marginLeft: "auto" }}
                disabled={draining}
                onClick={() => void drainDeliveries()}
              >
                {draining ? "Sending" : "Send queued now"}
              </button>

              <span className="small muted">{deliveries.length} rows</span>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Order</th><th>Channel</th><th>Status</th><th>Recipient</th><th>Key</th><th>Created</th><th>Sent</th><th></th></tr>
                </thead>
                <tbody>
                  {deliveries.length === 0 && <tr><td colSpan={8} className="muted">Nothing here.</td></tr>}
                  {deliveries.map((d, i) => (
                    <tr key={i}>
                      <td>{d.order_number}</td>
                      <td>{d.channel}</td>
                      <td><span className={`pill pill-${d.status}`}>{d.status}</span></td>
                      <td>{d.recipient ?? "—"}</td>
                      <td style={{ color: "var(--steel)" }}>{d.key_code ?? "—"}</td>
                      <td>{when(d.created_at)}</td>
                      <td>{when(d.sent_at)}</td>
                      <td>
                        {d.channel === "email" && d.status === "queued" && (
                          <button
                            className="copy-btn"
                            onClick={() => void act("admin_mark_delivered", { p_order: d.order_number },
                                                    `Marked ${d.order_number} as emailed.`)}
                          >
                            MARK SENT
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* -------------------------------------------------------- releases */}
        {tab === "releases" && (
          <>
            <div className="notice notice-info">
              The installer file itself lives in{" "}
              <span className="mono">lost-website/public/downloads/</span>. Publishing here
              records which build is current and where to find it &mdash; copy the new
              .exe into that folder first, then publish it below.
            </div>

            <div className="table-wrap" style={{ marginBottom: 20 }}>
              <table className="data">
                <thead>
                  <tr><th>Plug-in</th><th>Version</th><th>File</th><th>Size</th><th>Downloads</th><th>Current</th><th>Published</th></tr>
                </thead>
                <tbody>
                  {releases.length === 0 && <tr><td colSpan={7} className="muted">No builds published.</td></tr>}
                  {releases.map((r) => (
                    <tr key={`${r.product_slug}-${r.version}-${r.platform}`}>
                      <td>{r.product}</td>
                      <td>{r.version}</td>
                      <td style={{ color: "var(--steel)" }}>{r.filename}</td>
                      <td>{megabytes(r.size_bytes)}</td>
                      <td style={{ color: "var(--mint)" }}>{r.download_count}</td>
                      <td>{r.is_current ? <span className="pill pill-used">current</span> : "—"}</td>
                      <td>{when(r.published_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PublishRelease
              products={products}
              defaultSlug={scope || products[0]?.slug || ""}
              onPublish={(args) => void act("admin_publish_release", args, "Release published.")}
            />
          </>
        )}

        {/* ---------------------------------------------------------- reviews */}
        {tab === "reviews" && (
          <>
            {reviews.some((r) => r.is_sample) && (
              <div className="notice notice-warn">
                <b>Placeholder reviews are live on the shop.</b> They are marked{" "}
                <span className="mono">sample</span> below and the storefront prints a
                warning above them saying they are not real customers. Clear them out
                before you take real orders.
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 12 }}
                  onClick={() => confirmAct(
                    {
                      title: "Delete every placeholder review?",
                      body: "Only the rows marked sample are removed. Real reviews are untouched, and this cannot be undone.",
                      confirm: "Delete placeholders",
                    },
                    "admin_purge_sample_reviews", {}, "Placeholders removed."
                  )}
                >
                  Delete all placeholders
                </button>
              </div>
            )}

            {/*  Cards, not a table.

                A review is a paragraph of somebody's prose. In a table it was squeezed
                into a 380px cell while Plug-in and Added -- the two things you never
                need -- took a full column each. What actually matters when moderating is
                the words, the rating, and whether it is on the shop; so the words get the
                width, and everything else arranges itself around them.               */}
            <div className="toolbar">
              <div className="tabs" style={{ margin: 0 }}>
                {["", "shown", "hidden", "sample"].map((f) => (
                  <button
                    key={f || "all"}
                    className={reviewFilter === f ? "is-on" : ""}
                    onClick={() => setReviewFilter(f)}
                  >
                    {f || "all"}
                  </button>
                ))}
              </div>
              <span className="small muted" style={{ marginLeft: "auto" }}>
                {visibleReviews.length} of {reviews.length}
              </span>
            </div>

            {visibleReviews.length === 0 ? (
              <div className="panel" style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}>
                <p className="eyebrow">Nothing here</p>
                <p className="small muted" style={{ marginTop: 6 }}>
                  {reviews.length === 0
                    ? "No reviews yet. Add the first one below as customers send them in."
                    : "No reviews match that filter."}
                </p>
              </div>
            ) : (
              <div className="review-grid">
                {visibleReviews.map((r) => (
                  <article key={r.id} className={`review-card${r.is_approved ? "" : " is-hidden"}`}>
                    <header className="review-head">
                      <div>
                        <span className="review-stars" title={`${r.rating} out of 5`}>
                          {"★".repeat(r.rating)}
                          <span className="review-stars-dim">{"★".repeat(5 - r.rating)}</span>
                        </span>
                        <div className="review-who">
                          {r.author_name}
                          {r.is_sample && <span className="pill" style={{ marginLeft: 8 }}>sample</span>}
                        </div>
                        {r.author_role && <div className="small muted">{r.author_role}</div>}
                      </div>

                      <span className={`pill ${r.is_approved ? "pill-used" : "pill-unused"}`}>
                        {r.is_approved ? "on the shop" : "hidden"}
                      </span>
                    </header>

                    {r.title && <h4 className="review-title">{r.title}</h4>}
                    <p className="review-body">{r.body}</p>

                    <footer className="review-foot">
                      <span className="small muted">{r.product} &middot; {when(r.created_at)}</span>

                      <div className="review-actions">
                        <button
                          className="copy-btn"
                          onClick={() => void act(
                            "admin_set_review",
                            { p_id: r.id, p_approved: !r.is_approved },
                            r.is_approved ? "Taken off the shop." : "Published."
                          )}
                        >
                          {r.is_approved ? "Hide" : "Publish"}
                        </button>

                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => confirmAct(
                            {
                              title: "Delete this review?",
                              body: `${r.author_name}'s review will be removed permanently. To take it off the shop without losing it, use Hide instead.`,
                              confirm: "Delete it",
                            },
                            "admin_delete_review", { p_id: r.id }, "Review deleted."
                          )}
                        >
                          Delete
                        </button>
                      </div>
                    </footer>
                  </article>
                ))}
              </div>
            )}

            <div style={{ marginTop: 20 }}>
              <AddReview
                products={products}
                defaultSlug={scope || products[0]?.slug || ""}
                onAdd={(args) => void act("admin_add_review", args, "Review added.")}
              />
            </div>
          </>
        )}

        {/* --------------------------------------------------------- plug-ins */}
        {tab === "plugins" && (
          <>
            <div className="table-wrap" style={{ marginBottom: 20 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Plug-in</th><th>Status</th><th>Price</th><th>Build</th>
                    <th>Keys left</th><th>Sold</th><th>Revenue</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {products.length === 0 && (
                    <tr><td colSpan={8} className="muted">No plug-ins yet. Add one below.</td></tr>
                  )}
                  {products.map((p) => (
                    <tr key={p.slug} className={draft?.slug === p.slug ? "is-editing" : ""}>
                      <td>
                        {p.name}
                        <div className="small muted" style={{ fontSize: 11 }}>{p.slug}</div>
                      </td>
                      <td>
                        <span className={`pill ${p.is_active ? "pill-used" : "pill-pending"}`}>
                          {p.is_active ? "listed" : "draft"}
                        </span>
                      </td>
                      <td>{money(p.price_cents, p.currency)}</td>
                      <td>{p.release_version ?? "—"}</td>
                      <td style={{ color: p.keys_unused === 0 ? "var(--red)" : "var(--mint)" }}>
                        {p.keys_unused}
                      </td>
                      <td>{p.keys_sold}</td>
                      <td>{money(p.revenue_cents, p.currency)}</td>
                      <td>
                        <button className="copy-btn" onClick={() => setDraft(p)}>EDIT</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="checkout">
              {draft && (
                <div className="panel">
                  <h3 style={{ marginBottom: 4 }}>{draft.name}</h3>
                  <p className="small muted mono" style={{ marginBottom: 16 }}>/plugins/{draft.slug}</p>

                  <div className="field">
                    <label>Name</label>
                    <input className="input" value={draft.name}
                           onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>

                  <div className="field">
                    <label>Tagline</label>
                    <input className="input" value={draft.tagline ?? ""}
                           onChange={(e) => setDraft({ ...draft, tagline: e.target.value })} />
                  </div>

                  <div className="field">
                    <label>Description</label>
                    <textarea className="input" style={{ minHeight: 90 }} value={draft.description ?? ""}
                              onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </div>

                  <div className="row">
                    <div className="field">
                      <label>Price (cents)</label>
                      <input className="input" type="number" value={draft.price_cents}
                             onChange={(e) => setDraft({ ...draft, price_cents: Number(e.target.value) })} />
                      <p className="small muted" style={{ marginTop: 6 }}>
                        Shown as {money(draft.price_cents, draft.currency)}
                      </p>
                    </div>

                    <div className="field">
                      <label>Version</label>
                      <input className="input" value={draft.version}
                             onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
                    </div>
                  </div>

                  <div className="row">
                    <div className="field">
                      <label>Badge</label>
                      <input className="input" value={draft.badge ?? ""}
                             onChange={(e) => setDraft({ ...draft, badge: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Order in the list</label>
                      <input className="input" type="number" value={draft.sort_order}
                             onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) })} />
                    </div>
                  </div>

                  <div className="field">
                    <label>&ldquo;Was&rdquo; price (cents, blank for no offer)</label>
                    <input className="input" type="number" placeholder="19900"
                           value={draft.compare_at_cents ?? ""}
                           onChange={(e) => setDraft({
                             ...draft,
                             compare_at_cents: e.target.value === "" ? null : Number(e.target.value),
                           })} />
                    <p className="small muted" style={{ marginTop: 6 }}>
                      {draft.compare_at_cents == null
                        ? "No discount shown."
                        : draft.compare_at_cents <= draft.price_cents
                          ? "Has to be above the price being charged, or it is not a discount."
                          : `Struck through as ${money(draft.compare_at_cents, draft.currency)} — saves ` +
                            `${money(draft.compare_at_cents - draft.price_cents, draft.currency)} ` +
                            `(${Math.round(((draft.compare_at_cents - draft.price_cents) / draft.compare_at_cents) * 100)}%).`}
                    </p>
                  </div>

                  <div className="field">
                    <label>Image path</label>
                    <input className="input" placeholder="/brand/newcasing.webp" value={draft.image_path ?? ""}
                           onChange={(e) => setDraft({ ...draft, image_path: e.target.value })} />
                  </div>

                  <div className="row">
                    <div className="field">
                      <label>Demo video path</label>
                      <input className="input" placeholder="/demo/lost-duck-walkthrough.mp4"
                             value={draft.demo_video_path ?? ""}
                             onChange={(e) => setDraft({ ...draft, demo_video_path: e.target.value })} />
                      <p className="small muted" style={{ marginTop: 6 }}>
                        Drop the file in <code>public/</code>. Blank shows the &ldquo;not up
                        yet&rdquo; panel rather than a dead player.
                      </p>
                    </div>
                    <div className="field">
                      <label>Demo poster path</label>
                      <input className="input" placeholder="/brand/plugin.webp"
                             value={draft.demo_poster_path ?? ""}
                             onChange={(e) => setDraft({ ...draft, demo_poster_path: e.target.value })} />
                    </div>
                  </div>

                  <div className="field">
                    <label>Platform line</label>
                    <input className="input" value={draft.platform}
                           onChange={(e) => setDraft({ ...draft, platform: e.target.value })} />
                  </div>

                  <label className="check">
                    <input type="checkbox" checked={draft.is_active}
                           onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
                    <span>Listed and buyable</span>
                  </label>

                  <button
                    className="btn btn-mint btn-block"
                    style={{ marginTop: 18 }}
                    onClick={() => void act("admin_save_product", {
                      p_slug: draft.slug, p_name: draft.name, p_tagline: draft.tagline,
                      p_description: draft.description, p_price: draft.price_cents,
                      p_version: draft.version, p_active: draft.is_active,
                      p_sort: draft.sort_order, p_badge: draft.badge,
                      p_image: draft.image_path, p_platform: draft.platform,
                      p_highlights: draft.highlights, p_features: draft.features,
                      p_specs: draft.specs, p_faq: draft.faq,
                      p_compare_at: draft.compare_at_cents ?? null,
                      p_demo_video: draft.demo_video_path ?? null,
                      p_demo_poster: draft.demo_poster_path ?? null,
                    }, `${draft.name} saved.`)}
                  >
                    Save changes
                  </button>

                  <button
                    className="btn btn-ghost btn-block"
                    style={{ marginTop: 10, borderColor: "rgba(255,90,90,0.45)", color: "#ffb4b4" }}
                    onClick={() => {
                      if (!window.confirm(`Delete ${draft.name}? Only possible while it has no orders or keys.`)) return;
                      void act("admin_delete_product", { p_slug: draft.slug }, `${draft.name} deleted.`);
                    }}
                  >
                    Delete
                  </button>

                  <PageContentEditor draft={draft} onChange={setDraft} />
                </div>
              )}

              <NewProduct onCreate={(args) => void act("admin_create_product", args, "Plug-in created as a draft.")} />
            </div>
          </>
        )}

        {/* ---------------------------------------------------------- import */}
        {tab === "import" && (
          <div className="panel">
            <h3 style={{ marginBottom: 8 }}>Import minted keys</h3>
            <p className="muted small">
              Paste the CSV from <span className="mono">LostDuckKeyGen</span>. One{" "}
              <span className="mono">serial,key</span> per line; the header is ignored and
              keys already in stock are skipped rather than duplicated.
            </p>

            <div className="notice notice-info">
              Keys are minted offline on your machine, never here. The signing secret is
              not on this server, so a breach of the store cannot produce working keys
              &mdash; only reveal which ones were already sold.
            </div>

            <div className="field">
              <label>Which plug-in are these keys for?</label>
              <select className="input" value={importSlug} onChange={(e) => setImportSlug(e.target.value)}>
                {products.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.name} — {p.keys_unused} in stock</option>
                ))}
              </select>
              <p className="small muted" style={{ marginTop: 6 }}>
                Keys belong to one plug-in and can only ever be sold as that plug-in.
              </p>
            </div>

            {/*  Drop the file rather than opening it, selecting all, and pasting.

                keys.csv is 5,000 lines. Pasting that means a text editor, a select-all,
                and a paste into a textarea that then has to render it -- and the file is
                sitting right there in Explorer. Dropping is the shorter path, and the
                textarea stays for the case where somebody has a handful of keys in an
                email rather than a file.                                              */}
            <div
              className={`dropzone${dragging ? " is-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void takeFile(e.dataTransfer.files?.[0]); }}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInput.current?.click(); }}
              aria-label="Drop a CSV of keys here, or click to choose one"
            >
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv,text/plain"
                style={{ display: "none" }}
                onChange={(e) => { void takeFile(e.target.files?.[0]); e.target.value = ""; }}
              />

              <p className="dropzone-title">
                {dragging ? "Let go to read it" : "Drop keys.csv here"}
              </p>
              <p className="small muted">or click to choose a file &middot; .csv or .txt, up to 5 MB</p>

              {fileNote && <p className="dropzone-note">{fileNote}</p>}
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>
                {csv.trim() === ""
                  ? "…or paste the rows"
                  : `${countKeyRows(csv)} rows ready to import`}
              </label>
              <textarea
                className="input"
                placeholder={"serial,key\n10000089,K2BD-JDAK-C2ME-AEPQ"}
                value={csv}
                onChange={(e) => { setCsv(e.target.value); setFileNote(null); }}
              />
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <button
                className="btn btn-ghost"
                disabled={csv === ""}
                onClick={() => { setCsv(""); setFileNote(null); }}
              >
                Clear
              </button>

              <button
                className="btn btn-mint"
                disabled={busy || countKeyRows(csv) === 0 || !importSlug}
                onClick={async () => {
                  const r = await call("admin_import_keys", { p_product_slug: importSlug, p_csv: csv });

                  if (r.ok) {
                    setMessage(
                      `Imported ${r.added} key${r.added === 1 ? "" : "s"}.` +
                      (r.skipped ? ` ${r.skipped} skipped — already in stock or malformed.` : "")
                    );
                    setError(null);
                    setCsv("");
                    setFileNote(null);
                    void refresh();
                  } else {
                    setError(r.error ?? "Import failed.");
                  }
                }}
              >
                {busy
                  ? "Importing"
                  : countKeyRows(csv) === 0
                    ? "Nothing to import"
                    : `Import ${countKeyRows(csv)} key${countKeyRows(csv) === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}

        {/* ----------------------------------------------------------- audit */}
        {tab === "audit" && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                {audit.length === 0 && <tr><td colSpan={4} className="muted">No admin actions recorded yet.</td></tr>}
                {audit.map((a, i) => (
                  <tr key={i}>
                    <td>{when(a.created_at)}</td>
                    <td><span className="pill pill-unused">{a.action}</span></td>
                    <td>{a.target ?? "—"}</td>
                    <td style={{ color: "var(--steel)", whiteSpace: "normal" }}>{JSON.stringify(a.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </div>{/* .admin-main */}
        </div>{/* .admin-layout */}
      </div>

      {/* ------------------------------------------------ confirm dialog */}
      {pending && (
        <div
          className="drawer-back"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onClick={() => setPending(null)}
        >
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-title" style={{ marginBottom: 8 }}>{pending.title}</h3>
            <p className="small muted" style={{ marginBottom: 18 }}>{pending.body}</p>

            <div className="confirm-actions">
              {/* Cancel first and focused: the safe way out should be the one your hand
                  is already on and the one Enter takes. */}
              <button className="btn btn-ghost" autoFocus onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => { const run = pending.run; setPending(null); run(); }}
              >
                {pending.confirm}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------- order drawer */}
      {detail && (
        <div className="drawer-back" onClick={() => setDetail(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <p className="eyebrow">Order</p>
                <h3>{detail.order.order_number}</h3>
              </div>
              <button className="copy-btn" onClick={() => setDetail(null)}>CLOSE</button>
            </div>

            <div className="summary-line"><span className="muted">Status</span>
              <span className={`pill pill-${detail.order.status}`}>{detail.order.status}</span></div>
            <div className="summary-line"><span className="muted">Customer</span><span>{detail.order.email}</span></div>
            <div className="summary-line"><span className="muted">Total</span>
              <span className="mono">{money(detail.order.total_cents, detail.order.currency)}</span></div>
            <div className="summary-line"><span className="muted">Placed</span><span>{when(detail.order.created_at)}</span></div>

            <h4 className="drawer-h">Payments</h4>
            {detail.payments.map((p, i) => (
              <div key={i} className="drawer-row">
                <span className={`pill pill-${p.status === "succeeded" ? "paid" : p.status === "failed" ? "failed" : "pending"}`}>
                  {p.status}
                </span>
                <span className="mono small">{p.provider} · {p.provider_ref ?? "—"}</span>
                <span className="mono small muted">{when(p.created_at)}</span>
              </div>
            ))}

            <h4 className="drawer-h">Keys</h4>
            {detail.keys.length === 0 && <p className="small muted">None issued.</p>}
            {detail.keys.map((k) => (
              <div key={k.key_code} className="drawer-row">
                <span className="mono" style={{ color: "var(--mint)" }}>{k.key_code}</span>
                <span className={`pill pill-${k.status}`}>{k.status}</span>
              </div>
            ))}

            <h4 className="drawer-h">Delivery</h4>
            {detail.deliveries.map((d, i) => (
              <div key={i} className="drawer-row">
                <span className="small">{d.channel}</span>
                <span className={`pill pill-${d.status}`}>{d.status}</span>
                <span className="small muted">{d.detail}</span>
              </div>
            ))}

            <h4 className="drawer-h">Downloads</h4>
            {detail.downloads.length === 0
              ? <p className="small muted">This customer has not downloaded the installer.</p>
              : detail.downloads.map((d, i) => (
                  <div key={i} className="drawer-row">
                    <span className="mono small">v{d.version}</span>
                    <span className="small muted">{when(d.created_at)}</span>
                  </div>
                ))}

            {detail.order.status === "paid" && (
              <button
                className="btn btn-ghost btn-block"
                style={{ marginTop: 22, borderColor: "rgba(255,90,90,0.5)", color: "#ffb4b4" }}
                onClick={() => {
                  const reason = window.prompt("Refund reason (recorded in the audit log):", "Customer request");
                  if (reason === null) return;

                  void act("admin_refund_order", { p_order: detail.order.order_number, p_reason: reason },
                           `Refunded ${detail.order.order_number}.`);
                  setDetail(null);
                }}
              >
                Refund and revoke keys
              </button>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

//=================================================================== new plug-in
function NewProduct({ onCreate }: { onCreate: (args: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [price, setPrice] = useState("4900");
  const [touchedSlug, setTouchedSlug] = useState(false);

  /* The slug follows the name until somebody edits it by hand, at which point it stops
     being clobbered. It is the product's URL, so it should be predictable but editable. */
  const suggest = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  return (
    <div className="panel">
      <h3 style={{ marginBottom: 6 }}>Add a plug-in</h3>
      <p className="small muted">
        Created as a draft, so it is not in the shop until you switch it on.
      </p>

      <div className="field">
        <label>Name</label>
        <input
          className="input"
          placeholder="LOST SWAN De-esser"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!touchedSlug) setSlug(suggest(e.target.value));
          }}
        />
      </div>

      <div className="field">
        <label>URL slug</label>
        <input
          className="input"
          placeholder="lost-swan-de-esser"
          value={slug}
          onChange={(e) => { setTouchedSlug(true); setSlug(e.target.value); }}
        />
        <p className="small muted" style={{ marginTop: 6 }}>/plugins/{slug || "…"}</p>
      </div>

      <div className="field">
        <label>Price (cents)</label>
        <input className="input" type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>

      <button
        className="btn btn-buy btn-block"
        disabled={!name.trim() || !slug.trim()}
        onClick={() => {
          onCreate({ p_slug: slug.trim(), p_name: name.trim(), p_price: Number(price) || 0 });
          setName(""); setSlug(""); setTouchedSlug(false);
        }}
      >
        Create
      </button>
    </div>
  );
}

//============================================================== page content editor
/** The product page's sections are JSON on the row. Edited as JSON rather than with a
 *  bespoke form per section: the shapes are small, and a form for each would be a lot of
 *  UI to maintain for something touched once per product. */
function PageContentEditor({
  draft,
  onChange,
}: {
  draft: ProductRow;
  onChange: (next: ProductRow) => void;
}) {
  const fields: { key: keyof ProductRow; label: string; hint: string }[] = [
    { key: "highlights", label: "Highlights", hint: '[{"value":"8.4 dB","label":"more gain"}]' },
    { key: "features", label: "Features", hint: '[{"n":"01","title":"…","body":"…"}]' },
    { key: "specs", label: "Specification", hint: '[["Format","VST3"],["Platform","Windows"]]' },
    { key: "faq", label: "FAQ", hint: '[{"q":"…","a":"…"}]' },
  ];

  const [errors, setErrors] = useState<Record<string, string>>({});

  return (
    <div style={{ marginTop: 26 }}>
      <h3 style={{ marginBottom: 6 }}>Page content</h3>
      <p className="small muted">
        These fill the sections on the product page. A section with an empty list hides
        itself, so a half-filled draft still looks deliberate.
      </p>

      {fields.map((f) => (
        <div className="field" key={String(f.key)}>
          <label>{f.label}</label>
          <textarea
            className="input"
            style={{ minHeight: 110, fontSize: 12 }}
            placeholder={f.hint}
            defaultValue={JSON.stringify(draft[f.key] ?? [], null, 1)}
            onBlur={(e) => {
              try {
                const parsed = JSON.parse(e.target.value || "[]");
                onChange({ ...draft, [f.key]: parsed });
                setErrors((s) => ({ ...s, [String(f.key)]: "" }));
              } catch (err) {
                setErrors((s) => ({ ...s, [String(f.key)]: String(err) }));
              }
            }}
          />
          {errors[String(f.key)] && (
            <p className="small" style={{ color: "var(--red)", marginTop: 4 }}>
              {errors[String(f.key)]} — not saved
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

//===================================================================== publish form
/*  Adding a review by hand.

    Deliberately not a public form. Nobody can post to this shop -- reviews arrive by
    email or in person and get typed in here, which is why there is no rating widget on
    the storefront. That is a smaller product than an open review system, and it is an
    honest one: everything on the page got there because a person put it there.       */
function AddReview({
  products,
  defaultSlug,
  onAdd,
}: {
  products: ProductRow[];
  defaultSlug: string;
  onAdd: (args: Record<string, unknown>) => void;
}) {
  const [slug, setSlug] = useState(defaultSlug);
  const [author, setAuthor] = useState("");
  const [role, setRole] = useState("");
  const [rating, setRating] = useState("5");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => { setSlug((s) => s || defaultSlug); }, [defaultSlug]);

  const ready = author.trim() !== "" && body.trim() !== "";

  return (
    <div className="panel">
      <h3 style={{ marginBottom: 14 }}>Add a review</h3>

      <div className="field">
        <label>Plug-in</label>
        <select className="input" value={slug} onChange={(e) => setSlug(e.target.value)}>
          {products.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </div>

      <div className="row">
        <div className="field">
          <label>Name</label>
          <input className="input" placeholder="Who said it"
                 value={author} onChange={(e) => setAuthor(e.target.value)} />
        </div>
        <div className="field">
          <label>Role (optional)</label>
          <input className="input" placeholder="FOH engineer, Manila"
                 value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Rating</label>
          <select className="input" value={rating} onChange={(e) => setRating(e.target.value)}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>{"★".repeat(n)} ({n})</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Headline (optional)</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>What they said</label>
        <textarea className="input" style={{ minHeight: 90 }}
                  value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      <button
        className="btn btn-mint btn-block"
        style={{ marginTop: 14 }}
        disabled={!ready}
        onClick={() => {
          onAdd({
            p_slug: slug, p_author: author.trim(), p_role: role.trim() || null,
            p_rating: Number(rating), p_title: title.trim() || null,
            p_body: body.trim(), p_approved: true,
          });
          setAuthor(""); setRole(""); setTitle(""); setBody("");
        }}
      >
        {ready ? "Publish this review" : "A name and a review are both needed"}
      </button>
    </div>
  );
}

function PublishRelease({
  products,
  defaultSlug,
  onPublish,
}: {
  products: ProductRow[];
  defaultSlug: string;
  onPublish: (args: Record<string, unknown>) => void;
}) {
  const [slug, setSlug] = useState(defaultSlug);
  const [version, setVersion] = useState("");
  const [filename, setFilename] = useState("");
  /*  Where the file actually lives. Blank keeps the old behaviour -- a path inside the
      site -- which is what the twelve releases already published use.                */
  const [downloadUrl, setDownloadUrl] = useState("");
  const [size, setSize] = useState("");
  const [sha, setSha] = useState("");
  const [notes, setNotes] = useState("");

  const trimmedUrl = downloadUrl.trim();

  /*  Checked here as well as in the database, because a rejected publish costs a round
      trip and this is a form somebody fills in with a 36 MB upload already behind them. */
  const urlProblem =
    trimmedUrl === "" ? null
      : /^http:\/\//i.test(trimmedUrl)
        ? "Use https. A plain http link to an installer can be tampered with in transit."
        : /^https:\/\//i.test(trimmedUrl) || trimmedUrl.startsWith("/")
          ? null
          : "Must be a full https:// URL, or a path starting with /.";

  useEffect(() => { setSlug((s) => s || defaultSlug); }, [defaultSlug]);

  return (
    <div className="panel">
      <h3 style={{ marginBottom: 14 }}>Publish a build</h3>

      <div className="field">
        <label>Plug-in</label>
        <select className="input" value={slug} onChange={(e) => setSlug(e.target.value)}>
          {products.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </div>

      <div className="row">
        <div className="field">
          <label>Version</label>
          <input className="input" placeholder="1.0.1" value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        <div className="field">
          <label>Size in bytes</label>
          <input className="input" placeholder="30001152" value={size} onChange={(e) => setSize(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>Filename</label>
        <input className="input" placeholder="LOST-DUCK-Anti-Feedback-1.0.1-Setup.exe"
               value={filename} onChange={(e) => setFilename(e.target.value)} />
        <p className="hint">Shown to the customer on the download panel.</p>
      </div>

      <div className="field">
        <label>Download URL</label>
        <input className="input" placeholder="https://…/storage/v1/object/public/downloads/file.exe?download="
               value={downloadUrl} onChange={(e) => setDownloadUrl(e.target.value)} />
        {urlProblem
          ? <p className="hint hint-bad">{urlProblem}</p>
          : (
            <p className="hint">
              Where the installer is hosted. Leave blank to serve it from the site itself
              at <span className="mono">/downloads/{filename.trim() || "filename.exe"}</span>,
              which only works if the file is committed to the website repository.
              {" "}For a file in Supabase Storage, end the URL with{" "}
              <span className="mono">?download=</span> so the browser saves it instead of
              trying to display it.
            </p>
          )}
      </div>

      <div className="field">
        <label>SHA-256</label>
        <input className="input" placeholder="Get-FileHash <file> -Algorithm SHA256"
               value={sha} onChange={(e) => setSha(e.target.value)} />
      </div>

      <div className="field">
        <label>Release notes</label>
        <input className="input" placeholder="What changed" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <button
        className="btn btn-mint btn-block"
        disabled={!version.trim() || !filename.trim() || !slug || urlProblem !== null}
        onClick={() => onPublish({
          p_slug: slug,
          p_version: version.trim(),
          p_filename: filename.trim(),
          p_url_path: trimmedUrl || `/downloads/${filename.trim()}`,
          p_size: Number(size) || 0,
          p_sha256: sha.trim(),
          p_notes: notes.trim(),
        })}
      >
        Publish as current
      </button>
    </div>
  );
}
