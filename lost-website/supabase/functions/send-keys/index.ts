import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*  Licence key delivery.

    Runs on the server because it holds two things the browser must never see: the Resend
    API key and the service role key. It is the only part of the shop allowed to send
    mail, and it is deliberately narrow -- it can read one order it was asked about and
    settle that order's delivery row, and nothing else. The database functions it calls
    (delivery_payload, delivery_settle, deliveries_pending) are revoked from anon and
    authenticated for the same reason.

    Two ways in, and both prove the caller already has the keys they are asking to be
    sent:

      customer   order_number + the email the order was placed with. Exactly the pair the
                 "Find my key" page already requires, so this grants nothing new -- it
                 re-sends to the address on the order, never to an address supplied by
                 the caller.

      admin      the back office token. Used for a manual resend and for draining the
                 queue.

    What it will not do is take a recipient address as input. An endpoint that emails a
    licence key to whatever address you name is a key generator with extra steps.      */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");

/*  Must be a domain verified in Resend. Until one is, Resend only accepts its shared
    sandbox sender and only delivers to the account owner -- which is why this is
    configuration rather than a constant.                                             */
const FROM = Deno.env.get("MAIL_FROM") ?? "LOST <onboarding@resend.dev>";
const REPLY_TO = Deno.env.get("MAIL_REPLY_TO") ?? undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

/** Calls a SECURITY DEFINER function as the service role. */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) throw new Error(`${fn}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

interface Payload {
  order_number: string;
  status: string;
  email: string;
  full_name: string | null;
  product: string;
  version: string;
  keys: string[];
}

/*  Plain text alongside the HTML, deliberately.

    A licence key is the one thing a customer will copy out of an email, sometimes from a
    phone client that renders no HTML at all. A mail with only an HTML part also scores
    worse with spam filters, and a key in the spam folder is a refund request.         */
function buildEmail(p: Payload) {
  const many = p.keys.length > 1;
  const keyBlock = p.keys.map((k) => escapeHtml(k)).join("</td></tr><tr><td style=\"padding:10px 14px;font-family:Consolas,monospace;font-size:16px;letter-spacing:1px;background:#fffbe6;border:2px solid #111;border-radius:8px\">");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f6f6f4;font-family:Consolas,'SF Mono',ui-monospace,monospace;color:#16181d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:3px solid #111;border-radius:16px;padding:32px">
        <tr><td>
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#6b7280">LOST</p>
          <h1 style="margin:0 0 16px;font-size:24px;line-height:1.2">${many ? "Your licence keys" : "Your licence key"}</h1>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563">
            Thank you${p.full_name ? `, ${escapeHtml(p.full_name)}` : ""}. Here ${many ? "are" : "is"}
            ${many ? `${p.keys.length} keys` : "the key"} for <b>${escapeHtml(p.product)}</b> v${escapeHtml(p.version)}.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px">
            <tr><td style="padding:10px 14px;font-family:Consolas,monospace;font-size:16px;letter-spacing:1px;background:#fffbe6;border:2px solid #111;border-radius:8px">${keyBlock}</td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#4b5563">
            Open the plug-in, click <b>DEMO</b> in the top right, and type the key in.
            It activates offline and stays activated.
          </p>
          <p style="margin:0 0 24px;font-size:13px;color:#6b7280">
            Order <b>${escapeHtml(p.order_number)}</b> &mdash; keep this email. You can also
            look the key up again with your order number and this email address.
          </p>
          <p style="margin:0;font-size:12px;color:#9ca3af">LOST &middot; developed by noobkodak</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    many ? "Your licence keys" : "Your licence key",
    "",
    `${p.product} v${p.version}`,
    "",
    ...p.keys,
    "",
    "Open the plug-in, click DEMO in the top right, and type the key in.",
    "It activates offline and stays activated.",
    "",
    `Order ${p.order_number} - keep this email.`,
    "LOST - developed by noobkodak",
  ].join("\n");

  return {
    subject: `${many ? "Your licence keys" : "Your licence key"} - ${p.product}`,
    html,
    text,
  };
}

async function sendOne(orderNumber: string) {
  const payload = await rpc<Payload | null>("delivery_payload", { p_order: orderNumber });

  if (!payload) return { order: orderNumber, ok: false, error: "Unknown order." };

  if (payload.status !== "paid") {
    return { order: orderNumber, ok: false, error: `Order is ${payload.status}, not paid.` };
  }

  if (!payload.keys?.length) {
    return { order: orderNumber, ok: false, error: "No keys are attached to that order yet." };
  }

  const mail = buildEmail(payload);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [payload.email],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    /*  Recorded as failed with the provider's own words. "Delivery failed" six weeks
        later tells nobody anything; "domain is not verified" is a fix.               */
    await rpc("delivery_settle", {
      p_order: orderNumber, p_status: "failed",
      p_detail: `resend ${response.status}: ${body}`,
    });
    return { order: orderNumber, ok: false, error: `Resend refused it (${response.status}).`, detail: body };
  }

  let id = "";
  try { id = JSON.parse(body)?.id ?? ""; } catch { /* id is a nicety, not a requirement */ }

  await rpc("delivery_settle", {
    p_order: orderNumber, p_status: "sent", p_detail: id ? `resend id ${id}` : "sent",
  });

  return { order: orderNumber, ok: true, id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== "POST") return json({ ok: false, error: "POST only." }, 405);

  if (!RESEND_KEY) {
    return json({ ok: false, error: "RESEND_API_KEY is not set on this project." }, 500);
  }

  let input: { order_number?: string; email?: string; token?: string; drain?: boolean };

  try {
    input = await req.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400);
  }

  const isAdmin = input.token
    ? await rpc<boolean>("admin_ok", { p_token: input.token })
    : false;

  //------------------------------------------------------------------ drain
  if (input.drain) {
    if (!isAdmin) return json({ ok: false, error: "Not authorised." }, 403);

    const pending = await rpc<string[]>("deliveries_pending", { p_limit: 25 });
    const results = [];

    for (const order of pending) results.push(await sendOne(order));

    return json({ ok: true, processed: results.length, results });
  }

  //--------------------------------------------------------------- one order
  const order = (input.order_number ?? "").trim().toUpperCase();
  if (!order) return json({ ok: false, error: "An order number is required." }, 400);

  if (!isAdmin) {
    /*  A customer has to prove which order is theirs the same way the lookup page makes
        them: the number *and* the address it was bought with. get_order is the existing
        function that enforces that pairing, so there is one rule rather than two that
        can drift apart.                                                               */
    const email = (input.email ?? "").trim();
    if (!email) return json({ ok: false, error: "An email address is required." }, 400);

    const check = await rpc<{ ok: boolean }>("get_order", {
      p_order_number: order, p_email: email, p_trusted: false,
    });

    if (!check?.ok) return json({ ok: false, error: "That order number and email do not match." }, 403);
  }

  const result = await sendOne(order);
  return json(result, result.ok ? 200 : 400);
});
