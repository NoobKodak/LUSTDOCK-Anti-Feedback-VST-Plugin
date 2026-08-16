# LOST store

The shop for **LOST DUCK Anti Feedback**. React + Vite + TypeScript on the front, Supabase
(Postgres) behind it.

```bash
npm install
npm run dev
```

Then open http://localhost:5174.

---

## What it does

| Page | Route | |
|---|---|---|
| Landing | `/` | Product, specs, pricing, FAQ |
| Checkout | `/checkout` | Details → payment → key on screen |
| Find my key | `/orders` | Order lookup by number + email |
| Admin | `/admin` | Stock, orders, key inventory, import |

## Admin access

The token is stored hashed in `admin_tokens`. The one created at setup is:

```
lostduck_5ea5f3f38c5ae7ca00304a54cf18d4350254
```

Treat it as a password. To issue a new one and retire this:

```sql
insert into admin_tokens (token_hash, label)
values (encode(sha256(convert_to('your-new-token','UTF8')),'hex'), 'replacement');

delete from admin_tokens where label = 'initial owner token';
```

This is **demo-grade** access control — a shared secret, not authentication. Before
anybody other than you can reach `/admin`, move it to Supabase Auth and check a role
claim inside the `admin_*` functions.

---

## How the money flows

Checkout is deliberately two steps, matching how every real gateway works:

```
create_checkout   order + pending payment row      (nothing charged, no key touched)
        ↓
   gateway.pay()  src/lib/payments.ts              (mock today)
        ↓
confirm_payment   settle payment, allocate keys, record delivery
```

Keys are allocated **inside `confirm_payment`**, so a declined card can never consume
stock. Verified: a declined order leaves `keys_on_unpaid_orders = 0`.

### Test cards

| Number | Result |
|---|---|
| `4242 4242 4242 4242` | Approved |
| `4000 0000 0000 0002` | Declined |

Anything failing a Luhn check is rejected as a typo.

### Wiring a real provider

Everything the checkout knows about money is behind `PaymentGateway` in
`src/lib/payments.ts`. Add a second implementation, point `activeGateway` at it, and
nothing else changes — the `payments` table already records `provider` and
`provider_ref` per attempt, so mock and real orders coexist.

The one change worth making at the same time: have the provider's **webhook** call
`confirm_payment` server-side rather than the browser. A browser can lie about a payment
succeeding; a signed webhook cannot.

---

## Database

| Table | |
|---|---|
| `products` | Catalogue. The only table readable directly — it is the shop window |
| `customers` | Deduplicated on lowercased email |
| `orders` | One per purchase attempt |
| `payments` | One per attempt, so a retry after a decline stays visible |
| `license_keys` | Stock. `unused` / `used` / `revoked` |
| `deliveries` | Every attempt to put a key in front of a customer, per channel |
| `admin_tokens` | Hashed admin secret |

Every table has RLS on with no policies except the product catalogue. Nothing is readable
from the browser directly; all access goes through security-definer functions. That is
what stops a customer reading the key table.

Key allocation uses `FOR UPDATE SKIP LOCKED`, so two simultaneous buyers take different
rows rather than one blocking on the other, and neither can be handed the same key.

---

## Stock

Keys are minted **offline**, on your machine, by `LostDuckKeyGen`:

```bash
".dist\build\LostDuckKeyGen_artefacts\Release\LostDuckKeyGen.exe" 5000 > keys.csv
```

Then paste the CSV into **Admin → Import stock**. Duplicates are skipped, so re-uploading
a file is harmless.

The signing secret never comes near this server. A breach of the store cannot produce
working keys — it can only reveal which ones were already sold.

100 keys were loaded at setup.

---

## Before this takes real money

1. **Connect a mail provider.** Email delivery is recorded but not sent. Every `queued`
   row in `deliveries` is a customer waiting. A Supabase Edge Function on a cron, reading
   the queue and calling `admin_mark_delivered`, is the smallest thing that works.
2. **Move payment confirmation server-side**, per the webhook note above.
3. **Replace the admin token with real auth.**
4. **Add terms, privacy and refund pages** — most payment providers require them before
   they will approve an account.
5. **Check tax.** Selling software internationally means VAT/GST obligations. A merchant
   of record like Paddle or Lemon Squeezy handles this for you; Stripe does not.
6. **Remove the demo banner** in `src/components/Chrome.tsx`.
