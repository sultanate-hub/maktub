// =====================================================================
// Maktub multi-network dashboard — Supabase edge function
// ---------------------------------------------------------------------
// One tenant, N manual MikroTik/Mikhmon networks. No customer payments.
// The only money flow is the owner's dashboard subscription:
//   N networks x N5,000, billed on the 10th, no grace period.
// =====================================================================

const enc = new TextEncoder();

const SB_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SQUAD_BASE = Deno.env.get("SQUAD_BASE_URL") || "https://api-d.squadco.com";
const SUB_SECRET = Deno.env.get("SUBSCRIPTION_SQUAD_SECRET_KEY") ||
  Deno.env.get("SQUAD_SECRET_KEY") || "";
const PUBLIC_BASE = Deno.env.get("PUBLIC_BASE_URL") ||
  "https://zmolotveyvkplfrgrqqw.supabase.co/functions/v1/maktub";
const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") ||
  "https://betelgeuse99.github.io/maktub-backend/";
const CRON_KEY = Deno.env.get("CRON_API_KEY") || "";
const SITE_ID = Deno.env.get("SITE_ID") || "maktub";
const SUB_EMAIL = Deno.env.get("SUB_EMAIL") || "";
const CORS_ORIGINS = (Deno.env.get("CORS_ORIGIN") ||
  "https://betelgeuse99.github.io,http://localhost:8000,http://127.0.0.1:8000")
  .split(",").map((s) => s.trim()).filter(Boolean);

// ---------- basic helpers ----------
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow = CORS_ORIGINS.includes(origin) ? origin : (CORS_ORIGINS[0] || "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type,x-session-id,x-api-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(data: unknown, status = 200, req?: Request): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req) Object.assign(headers, corsHeaders(req));
  return new Response(JSON.stringify(data), { status, headers });
}
function text(data: string, status = 200): Response {
  return new Response(data, { status, headers: { "Content-Type": "text/plain" } });
}
function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// ---------- PostgREST ----------
function sbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}
async function sbGet(table: string, params: Record<string, string>): Promise<any[]> {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`db ${table}: ${await r.text()}`);
  return await r.json();
}
async function sbPost(
  table: string,
  body: unknown,
  opts: { prefer?: string; onConflict?: string } = {},
): Promise<any> {
  const q = opts.onConflict ? `?on_conflict=${encodeURIComponent(opts.onConflict)}` : "";
  const r = await fetch(`${SB_URL}/rest/v1/${table}${q}`, {
    method: "POST",
    headers: sbHeaders({
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=representation",
    }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${table}: ${await r.text()}`);
  const raw = await r.text();
  return raw ? JSON.parse(raw) : null;
}
async function sbPatch(tableQuery: string, body: unknown): Promise<void> {
  const r = await fetch(`${SB_URL}/rest/v1/${tableQuery}`, {
    method: "PATCH",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${tableQuery}: ${await r.text()}`);
}
async function sbRpc(fn: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`rpc ${fn}: ${await r.text()}`);
  return await r.json();
}

// ---------- crypto ----------
async function sha256hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return hex(new Uint8Array(sig)).toUpperCase();
}
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]) || 150000;
  const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
  const expected = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
  const actual = await deriveBits(password, salt, iterations);
  return safeEqual(actual, expected);
}
async function makePasswordHash(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = 150000;
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...bits))}`;
}

// ---------- sessions ----------
async function currentSession(req: Request): Promise<any | null> {
  const sid = req.headers.get("x-session-id") ||
    new URL(req.url).searchParams.get("sessionId") || "";
  if (!sid) return null;
  const rows = await sbGet("admin_sessions", {
    session_id: `eq.${sid}`,
    revoked: "eq.false",
    select: "*",
    limit: "1",
  });
  const s = rows[0];
  if (!s) return null;
  const now = Date.now();
  if (now - new Date(s.created_at).getTime() > 12 * 3600 * 1000) return null;
  if (now - new Date(s.last_activity).getTime() > 2 * 3600 * 1000) return null;
  await sbPatch(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}`, {
    last_activity: new Date().toISOString(),
  });
  return s;
}

// ---------- tenant / licence ----------
async function getTenant(): Promise<any> {
  const rows = await sbGet("tenant", { id: "eq.1", select: "*", limit: "1" });
  if (!rows[0]) throw new Error("tenant not configured");
  return rows[0];
}
function licenceActive(t: any): boolean {
  return !!t && t.status === "active" && new Date(t.paid_until).getTime() > Date.now();
}
async function activeNetworks(): Promise<any[]> {
  return await sbGet("networks", {
    status: "eq.active",
    select: "id,name,slug,last_sync,plan_prices",
    order: "name.asc",
  });
}
function amountDueNaira(t: any, count: number): number {
  return Math.round((count * Number(t.per_network_amount || 500000)) / 100);
}
function tenthUtc(year: number, month: number): number {
  // 10th 00:00 Africa/Lagos (UTC+1, no DST) = 9th 23:00 UTC
  return Date.UTC(year, month, 9, 23, 0, 0);
}
function nextTenthAfter(reference: Date): Date {
  let y = reference.getUTCFullYear();
  let m = reference.getUTCMonth();
  let t = tenthUtc(y, m);
  if (t <= reference.getTime()) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    t = tenthUtc(y, m);
  }
  return new Date(t);
}
function gatePayload(t: any, count: number): Record<string, unknown> {
  return {
    success: false,
    error: "subscription_required",
    active: false,
    paid_until: t?.paid_until ?? null,
    amount_due: amountDueNaira(t, count),
    network_count: count,
  };
}

// ---------- plans / router parsing ----------
const PAID_PLANS = new Set(["24hr", "3d", "5d", "7d", "14d", "30d"]);
const PLAN_HOURS: Record<string, number> = {
  "24hr": 24,
  "3d": 72,
  "5d": 120,
  "7d": 168,
  "14d": 336,
  "30d": 720,
};
function mapPlan(profile: unknown): string {
  const p = String(profile ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["24hr", "24hrs", "24-hour", "24-hours", "daily", "1d"].includes(p)) return "24hr";
  if (["3d", "3day", "3days", "3-day", "3-days"].includes(p)) return "3d";
  if (["5d", "5day", "5days", "5-day", "5-days"].includes(p)) return "5d";
  if (["7d", "7day", "7days", "7-day", "7-days", "1w", "weekly"].includes(p)) return "7d";
  if (["14d", "14day", "14days", "14-day", "14-days", "2w"].includes(p)) return "14d";
  if (["30d", "30day", "30days", "30-day", "30-days", "4w2d", "monthly"].includes(p)) return "30d";
  if (["6h", "6hour", "6hours", "6-hour", "6-hours"].includes(p)) return "6h";
  if (p === "default") return "default";
  return "other";
}
function parseMikhmonExpiry(comment: unknown): string | null {
  const m = String(comment ?? "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+01:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function routerSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const epoch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (epoch) {
    const t = Date.parse(`${epoch[1]}-${epoch[2]}-${epoch[3]}T${epoch[4]}:${epoch[5]}:${epoch[6]}Z`);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  const clock = raw.match(/^(?:(\d+)w)?(?:(\d+)d)?(\d{1,2}):(\d{2}):(\d{2})$/);
  if (clock) {
    return Number(clock[1] ?? 0) * 604800 + Number(clock[2] ?? 0) * 86400 +
      Number(clock[3]) * 3600 + Number(clock[4]) * 60 + Number(clock[5]);
  }
  const units = raw.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (units && /[wdhms]/.test(raw)) {
    return Number(units[1] ?? 0) * 604800 + Number(units[2] ?? 0) * 86400 +
      Number(units[3] ?? 0) * 3600 + Number(units[4] ?? 0) * 60 + Number(units[5] ?? 0);
  }
  return null;
}
interface SyncUser {
  name: string;
  password: string;
  profile: string;
  mac: string;
  disabled: boolean;
  limit: string;
  uptime: string;
  comment: string;
}
interface SyncActive {
  name: string;
  mac: string;
  ip: string;
  uptime: string;
  idle: string;
}
function parseSyncBody(raw: string, isJson: boolean): { users: SyncUser[]; active: SyncActive[]; full: boolean } {
  const users: SyncUser[] = [];
  const active: SyncActive[] = [];
  let full = true;
  if (isJson) {
    const body = JSON.parse(raw || "{}");
    for (const u of body.users || []) {
      users.push({
        name: String(u.name ?? "").trim(),
        password: String(u.password ?? ""),
        profile: String(u.profile ?? ""),
        mac: String(u.mac ?? u["mac-address"] ?? "").toUpperCase(),
        disabled: String(u.disabled ?? "") === "true",
        limit: String(u["limit-uptime"] ?? ""),
        uptime: String(u.uptime ?? ""),
        comment: String(u.comment ?? ""),
      });
    }
    for (const a of body.active || []) {
      if (typeof a === "string") {
        active.push({ name: a, mac: "", ip: "", uptime: "", idle: "" });
      } else {
        active.push({
          name: String(a.name ?? ""),
          mac: String(a.mac ?? a["mac-address"] ?? "").toUpperCase(),
          ip: String(a.ip ?? a.address ?? ""),
          uptime: String(a.uptime ?? ""),
          idle: String(a["idle-time"] ?? a.idle ?? ""),
        });
      }
    }
    if (body.full === false) full = false;
    return { users: users.filter((u) => u.name), active: active.filter((a) => a.name), full };
  }
  for (const line of raw.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (clean.length < 2) continue;
    if (clean.startsWith("A|")) {
      const p = clean.split("|");
      const name = String(p[1] ?? "").trim();
      if (name) {
        active.push({
          name,
          mac: String(p[2] ?? "").toUpperCase(),
          ip: String(p[3] ?? ""),
          uptime: String(p[4] ?? ""),
          idle: String(p[5] ?? ""),
        });
      }
      continue;
    }
    if (clean.startsWith("F|")) {
      full = clean.slice(2).trim() !== "0";
      continue;
    }
    if (!clean.startsWith("U|")) continue;
    const p = clean.split("|");
    const name = String(p[1] ?? "").trim();
    if (!name) continue;
    users.push({
      name,
      password: p[2] ?? "",
      profile: p[3] ?? "",
      mac: String(p[4] ?? "").toUpperCase(),
      disabled: String(p[5] ?? "") === "true",
      limit: p[6] ?? "",
      uptime: p[7] ?? "",
      comment: p.slice(8).join("|"),
    });
  }
  return { users, active, full };
}
async function networkByKey(req: Request): Promise<any | null> {
  const key = req.headers.get("x-api-key") || "";
  if (!key) return null;
  const hash = await sha256hex(key);
  const rows = await sbGet("networks", { api_key_hash: `eq.${hash}`, select: "*", limit: "1" });
  return rows[0] || null;
}

// ---------- subscription ----------
async function verifySubSquad(ref: string): Promise<any | null> {
  if (!SUB_SECRET) return null;
  const r = await fetch(`${SQUAD_BASE}/transaction/verify/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${SUB_SECRET}` },
  });
  const data = await r.json();
  return data?.data || null;
}
async function applySubscriptionPayment(
  ref: string,
  amount: number,
  tokenId: string | null,
  email: string | null,
  raw: unknown,
): Promise<boolean> {
  if (!ref) return false;
  const existing = await sbGet("subscription_payments", {
    reference: `eq.${ref}`,
    select: "status",
    limit: "1",
  });
  if (existing[0]?.status === "success") return true;

  const t = await getTenant();
  const base = Math.max(Date.now(), new Date(t.paid_until).getTime());
  const paidUntil = nextTenthAfter(new Date(base));
  const count = (await activeNetworks()).length;

  await sbPost(
    "subscription_payments",
    {
      reference: ref,
      amount,
      status: "success",
      kind: "subscription",
      network_count: count,
      paid_until: paidUntil.toISOString(),
      email,
      token_id: tokenId,
      raw: raw ?? null,
    },
    { onConflict: "reference", prefer: "resolution=merge-duplicates,return=minimal" },
  );
  await sbPatch("tenant?id=eq.1", {
    status: "active",
    paid_until: paidUntil.toISOString(),
    last_reference: ref,
    email: email || t.email,
    ...(tokenId ? { squad_token_id: tokenId } : {}),
    updated_at: new Date().toISOString(),
  });
  await sbPost("activity_log", {
    level: "subscription",
    message: `Licence paid — N${Math.round(amount / 100).toLocaleString()} for ${count} network(s), valid to ${paidUntil.toISOString()}`,
    ref,
  });
  return true;
}
async function subscriptionStatus(req: Request): Promise<Response> {
  const t = await getTenant();
  const count = (await activeNetworks()).length;
  return json({
    site: SITE_ID,
    active: licenceActive(t),
    status: t.status,
    paid_until: t.paid_until,
    network_count: count,
    per_network_amount: Math.round(Number(t.per_network_amount) / 100),
    amount_due: amountDueNaira(t, count),
    configured: !!SUB_SECRET,
  }, 200, req);
}
async function subscriptionInitiate(req: Request): Promise<Response> {
  if (!SUB_SECRET) return json({ error: "Subscription payments are not configured." }, 503, req);
  const body = await req.json().catch(() => ({}));
  const t = await getTenant();
  const nets = await activeNetworks();
  const count = nets.length;
  if (count === 0) return json({ error: "No active networks" }, 400, req);
  const amount = count * Number(t.per_network_amount); // kobo
  const email = String(body.email || t.email || SUB_EMAIL || "").trim();
  if (!email) return json({ error: "A receipt email is required" }, 400, req);
  const reference = "MAK" + Date.now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  try {
    const res = await fetch(`${SQUAD_BASE}/transaction/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUB_SECRET}` },
      body: JSON.stringify({
        amount,
        email,
        currency: "NGN",
        initiate_type: "inline",
        transaction_ref: reference,
        customer_name: "Maktub",
        callback_url: `${PUBLIC_BASE}/subscription-callback`,
        payment_channels: ["card", "bank", "transfer"],
        metadata: { kind: "subscription", site: SITE_ID },
        pass_charge: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data?.data?.checkout_url) {
      return json({ error: "Could not start checkout", details: data?.message }, 502, req);
    }
    await sbPost("subscription_payments", {
      reference,
      amount,
      status: "pending",
      kind: "checkout",
      network_count: count,
      email,
    });
    await sbPost("activity_log", {
      level: "subscription",
      message: `Checkout started — N${Math.round(amount / 100).toLocaleString()} for ${count} network(s)`,
      ref: reference,
    });
    return json({
      success: true,
      checkout_url: data.data.checkout_url,
      reference,
      amount: Math.round(amount / 100),
    }, 200, req);
  } catch (e) {
    console.error("subscription initiate", e);
    return json({ error: "Payment provider error" }, 502, req);
  }
}
async function subscriptionWebhook(req: Request): Promise<Response> {
  const raw = await req.text();
  const secret = SUB_SECRET;
  const received = (req.headers.get("x-squad-encrypted-body") || "").toUpperCase();
  const computed = secret ? (await hmacSha512Hex(secret, raw)).toUpperCase() : "";
  if (!secret || !received || computed !== received) {
    return new Response("Invalid signature", { status: 400 });
  }
  try {
    const body = JSON.parse(raw);
    const { Event, Body } = body || {};
    const meta = (Body?.meta || {}) as Record<string, unknown>;
    // Shared Dream Hatcher account: only apply Maktub subscription events.
    if (meta.kind !== "subscription") return json({ received: true }, 200, req);
    if (meta.site && meta.site !== SITE_ID) return json({ received: true }, 200, req);
    if (Event !== "charge_successful" || !Body ||
        String(Body.transaction_status || "").toLowerCase() !== "success") {
      return json({ received: true }, 200, req);
    }
    await applySubscriptionPayment(
      String(Body.transaction_ref),
      Number(Body.amount) || 0,
      Body?.payment_information?.token_id || null,
      Body.email || null,
      Body,
    );
    return json({ received: true }, 200, req);
  } catch (e) {
    console.error("subscription webhook", e);
    return json({ error: "Webhook processing failed" }, 500, req);
  }
}
async function subscriptionCallback(req: Request): Promise<Response> {
  const ref = new URL(req.url).searchParams.get("transaction_ref") ||
    new URL(req.url).searchParams.get("reference") || "";
  if (ref) {
    try {
      const rows = await sbGet("subscription_payments", {
        reference: `eq.${ref}`,
        select: "status",
        limit: "1",
      });
      if (!rows[0] || rows[0].status !== "success") {
        const v = await verifySubSquad(ref);
        if (v && String(v.transaction_status || "").toLowerCase() === "success") {
          const info = (v.payment_information || {}) as Record<string, unknown>;
          await applySubscriptionPayment(
            ref,
            Number(v.transaction_amount) || 0,
            (info.token_id as string) || null,
            (v.email as string) || null,
            v,
          );
        }
      }
    } catch (e) {
      console.error("subscription callback", e);
    }
  }
  return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_URL}?subscribed=1` } });
}
async function subscriptionReconcile(req: Request): Promise<Response> {
  const key = req.headers.get("x-api-key") || new URL(req.url).searchParams.get("api_key") || "";
  if (!CRON_KEY || key !== CRON_KEY) return text("FORBIDDEN", 403);
  if (!SUB_SECRET) return json({ checked: 0, applied: 0, reason: "not configured" }, 200, req);
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const rows = await sbGet("subscription_payments", {
    status: "eq.pending",
    created_at: `gte.${since}`,
    select: "reference,amount",
    limit: "25",
  });
  let applied = 0;
  for (const row of rows) {
    const v = await verifySubSquad(row.reference);
    if (v && String(v.transaction_status || "").toLowerCase() === "success") {
      const info = (v.payment_information || {}) as Record<string, unknown>;
      await applySubscriptionPayment(
        row.reference,
        Number(v.transaction_amount) || Number(row.amount) || 0,
        (info.token_id as string) || null,
        (v.email as string) || null,
        v,
      );
      applied++;
    }
  }
  return json({ checked: rows.length, applied }, 200, req);
}

// ---------- networks / stats ----------
function statNumbers(row: any) {
  return {
    online: Number(row?.online || 0),
    expired: Number(row?.expired || 0),
    active: Number(row?.active || 0),
    total: Number(row?.total || 0),
    unused: Number(row?.unused || 0),
    revenue_today: Number(row?.revenue_today || 0),
    revenue_week: Number(row?.revenue_week || 0),
    revenue_month: Number(row?.revenue_month || 0),
  };
}
async function handleNetworks(req: Request, session: any): Promise<Response> {
  const t = await getTenant();
  const nets = await activeNetworks();
  const privileged = session?.role === "super_admin";
  if (!privileged && !licenceActive(t)) return json(gatePayload(t, nets.length), 402, req);
  const stats = await sbRpc("maktub_network_stats");
  const byId = new Map((stats || []).map((s: any) => [String(s.network_id), s]));
  return json({
    success: true,
    tenant: {
      name: t.name,
      status: t.status,
      paid_until: t.paid_until,
      amount_due: amountDueNaira(t, nets.length),
      network_count: nets.length,
    },
    networks: nets.map((n) => ({
      id: n.id,
      name: n.name,
      slug: n.slug,
      last_sync: n.last_sync,
      ...statNumbers(byId.get(String(n.id))),
    })),
  }, 200, req);
}
async function handleNetwork(req: Request, slug: string, part?: string, session?: any): Promise<Response> {
  const t = await getTenant();
  const nets = await activeNetworks();
  const privileged = session?.role === "super_admin";
  if (!privileged && !licenceActive(t)) return json(gatePayload(t, nets.length), 402, req);
  const rows = await sbGet("networks", { slug: `eq.${slug}`, select: "*", limit: "1" });
  const network = rows[0];
  if (!network || network.status !== "active") return json({ error: "Network not found" }, 404, req);

  if (part === "users") {
    const q = new URL(req.url).searchParams;
    const search = (q.get("search") || "").trim();
    const status = (q.get("status") || "all").trim();
    const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(q.get("limit") || "50", 10) || 50));
    const offset = (page - 1) * limit;
    const data = await sbRpc("maktub_users", {
      p_network: network.id,
      p_search: search,
      p_status: status,
      p_limit: limit,
      p_offset: offset,
    });
    const total = Number(data?.[0]?.total_count || 0);
    return json({
      success: true,
      data: (data || []).map((r: any) => ({
        username: r.username,
        plan: r.plan,
        profile: r.profile,
        mac: r.mac_address,
        status: r.status,
        expires_at: r.expires_at,
        first_login_at: r.first_login_at,
        last_seen: r.last_seen,
        online: !!r.online,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    }, 200, req);
  }

  if (part === "activity") {
    const q = new URL(req.url).searchParams;
    const limit = Math.min(200, Math.max(10, parseInt(q.get("limit") || "80", 10) || 80));
    const data = await sbGet("activity_log", {
      network_id: `eq.${network.id}`,
      select: "*",
      order: "created_at.desc",
      limit: String(limit),
    });
    return json({ success: true, data }, 200, req);
  }

  const stats = await sbRpc("maktub_network_stats");
  const row = (stats || []).find((s: any) => String(s.network_id) === String(network.id));
  return json({
    success: true,
    network: { id: network.id, name: network.name, slug: network.slug, last_sync: network.last_sync },
    stats: statNumbers(row),
  }, 200, req);
}

// ---------- sync ----------
async function handleSync(req: Request): Promise<Response> {
  const network = await networkByKey(req);
  if (!network) return json({ error: "Invalid API key" }, 401, req);
  const t = await getTenant();
  const count = (await activeNetworks()).length;
  if (!licenceActive(t)) {
    return json({ ...gatePayload(t, count), error: "subscription_required" }, 403, req);
  }
  if (network.status !== "active") return json({ error: "Network disabled" }, 403, req);

  const raw = await req.text();
  const isJson = (req.headers.get("content-type") || "").includes("json");
  let payload: { users: SyncUser[]; active: string[]; full: boolean };
  try {
    payload = parseSyncBody(raw, isJson);
  } catch (e) {
    return json({ error: "Invalid payload: " + (e as Error).message }, 400, req);
  }
  if (payload.users.length === 0 && payload.active.length === 0) {
    return json({ success: true, received: 0, created: 0, updated: 0, expired: 0 }, 200, req);
  }

  const existing = await sbGet("mikrotik_users", {
    network_id: `eq.${network.id}`,
    select: "id,username,first_login_at,last_seen,expires_at,status,used,mac_address",
    limit: "10000",
  });
  const byName = new Map<string, any>(existing.map((r: any) => [String(r.username), r]));
  const activeSet = new Set(payload.active.map((x) => x.name));
  const activeInfo = new Map(payload.active.map((x) => [x.name, x]));
  const prices = (network.plan_prices || {}) as Record<string, number>;
  const now = new Date();
  const nowIso = now.toISOString();
  const rows: any[] = [];
  let skipped = 0;

  for (const u of payload.users) {
    if (u.profile === "default" || !u.profile) { skipped++; continue; }
    const old = byName.get(u.name);
    const plan = mapPlan(u.profile);
    const info = activeInfo.get(u.name);
    const seen = !!info;
    const activeMac = info?.mac && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(info.mac) ? info.mac : null;
    const idleSec = info?.idle ? routerSeconds(info.idle) : null;
    const commentExpiry = parseMikhmonExpiry(u.comment);
    const oldUsed = !!old?.used || !!old?.first_login_at;

    let expires: string | null = commentExpiry || old?.expires_at || null;
    // Only derive an expiry from limit-uptime for vouchers that have actually
    // been used. Unused vouchers also carry a limit-uptime; deriving an expiry
    // for them would incorrectly mark them as used.
    if (!expires && (seen || oldUsed) && u.limit) {
      const limit = routerSeconds(u.limit);
      const uptime = routerSeconds(u.uptime);
      if (limit !== null && uptime !== null && limit > 0) {
        expires = new Date(now.getTime() + Math.max(0, limit - uptime) * 1000).toISOString();
      }
    }

    const used = seen || !!commentExpiry || oldUsed;
    const disabled = u.disabled || u.limit === "1s";
    const expired = used && (disabled ||
      (expires !== null && new Date(expires).getTime() <= now.getTime()));

    // Activation time: for priced plans, expiry - duration is the actual
    // voucher start, so today/week/month revenue are genuinely different.
    let first: string | null = old?.first_login_at || null;
    const hours = PLAN_HOURS[plan];
    if (used && expires && hours) {
      first = new Date(new Date(expires).getTime() - hours * 3600 * 1000).toISOString();
    }
    if (used && !first) first = nowIso;

    rows.push({
      network_id: network.id,
      username: u.name,
      password: u.password,
      profile: u.profile,
      plan,
      mac_address: activeMac || u.mac || old?.mac_address || null,
      expires_at: used ? expires : null,
      status: expired ? "expired" : "active",
      used,
      first_login_at: used ? first : null,
      last_seen: seen
        ? (idleSec !== null ? new Date(now.getTime() - idleSec * 1000).toISOString() : nowIso)
        : (old?.last_seen ?? null),
      disabled,
      comment: u.comment,
      updated_at: nowIso,
    });
  }

  let created = 0;
  let updated = 0;
  for (const r of rows) {
    if (byName.has(r.username)) updated++;
    else created++;
  }
  for (let i = 0; i < rows.length; i += 400) {
    await sbPost("mikrotik_users", rows.slice(i, i + 400), {
      onConflict: "network_id,username",
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }

  // Never delete or expire users just because they are absent from a payload:
  // the router sends used vouchers in chunks, and Mikhmon rows are kept for
  // history until their own expiry passes. This makes chunked syncs safe.
  const removed = 0;

  const expiredByTime = await sbRpc("maktub_expire_users");
  await sbPatch(`networks?id=eq.${network.id}`, { last_sync: nowIso });

  if (created > 0 || removed > 0 || Number(expiredByTime) > 0) {
    await sbPost("activity_log", {
      network_id: network.id,
      level: "sync",
      message: `Sync — +${created} new, ${removed} removed, ${Number(expiredByTime)} expired`,
      ref: null,
    });
  }

  return json({
    success: true,
    received: payload.users.length,
    eligible: rows.length,
    skipped,
    created,
    updated,
    expired: removed + Number(expiredByTime),
  }, 200, req);
}

// ---------- licence check (router-side lockout) ----------
async function handleLicence(req: Request): Promise<Response> {
  const network = await networkByKey(req);
  if (!network) return json({ error: "Invalid API key" }, 401, req);
  const t = await getTenant();
  const count = (await activeNetworks()).length;
  return json({
    active: licenceActive(t) && network.status === "active",
    tenant_status: t.status,
    paid_until: t.paid_until,
    amount_due: amountDueNaira(t, count),
    network_count: count,
    server_time: new Date().toISOString(),
  }, 200, req);
}

// ---------- auth ----------
async function handleLogin(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return json({ error: "Username and password required" }, 400, req);
  const rows = await sbGet("admin_users", { username: `eq.${username}`, select: "*", limit: "1" });
  const user = rows[0];
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) {
    await new Promise((r) => setTimeout(r, 350));
    return json({ success: false, error: "Invalid credentials" }, 401, req);
  }
  const sid = randHex(32);
  await sbPost("admin_sessions", {
    session_id: sid,
    username: user.username,
    role: user.role,
    ip: clientIp(req),
    user_agent: req.headers.get("user-agent") || "",
  });
  await sbPost("activity_log", {
    level: "auth",
    message: `Login — ${user.username} from ${clientIp(req)}`,
  });
  return json({ success: true, sessionId: sid, username: user.username, role: user.role }, 200, req);
}
async function handleLogout(req: Request, session: any): Promise<Response> {
  await sbPatch(`admin_sessions?session_id=eq.${encodeURIComponent(session.session_id)}`, {
    revoked: true,
  });
  return json({ success: true }, 200, req);
}
async function handleChangePassword(req: Request, session: any): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");
  if (next.length < 8) return json({ error: "New password must be at least 8 characters" }, 400, req);
  const rows = await sbGet("admin_users", {
    username: `eq.${session.username}`,
    select: "password_hash",
    limit: "1",
  });
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) {
    return json({ error: "Current password is incorrect" }, 401, req);
  }
  await sbPatch(`admin_users?username=eq.${encodeURIComponent(session.username)}`, {
    password_hash: await makePasswordHash(next),
    updated_at: new Date().toISOString(),
  });
  await sbPatch(`admin_sessions?session_id=neq.${encodeURIComponent(session.session_id)}`, {
    revoked: true,
  });
  return json({ success: true }, 200, req);
}

// ---------- router ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  const url = new URL(req.url);
  const idx = url.pathname.indexOf("/maktub");
  const path = idx >= 0 ? (url.pathname.slice(idx + "/maktub".length) || "/") : url.pathname;

  try {
    if (path === "/health" && req.method === "GET") {
      const t = await getTenant();
      const nets = await activeNetworks();
      return json({
        status: "OK",
        tenant: t.name,
        active: licenceActive(t),
        paid_until: t.paid_until,
        networks: nets.length,
        server_time: new Date().toISOString(),
      }, 200, req);
    }
    if (path === "/api/login" && req.method === "POST") return await handleLogin(req);
    if (path === "/api/subscription/status" && req.method === "GET") return await subscriptionStatus(req);
    if (path === "/api/subscription/initiate" && req.method === "POST") return await subscriptionInitiate(req);
    if (path === "/api/subscription-webhook" && req.method === "POST") return await subscriptionWebhook(req);
    if (path === "/api/subscription/reconcile" && req.method === "POST") return await subscriptionReconcile(req);
    if (path === "/subscription-callback" && req.method === "GET") return await subscriptionCallback(req);

    if (path === "/api/mikhmon-sync" && req.method === "POST") return await handleSync(req);
    if (path === "/api/licence" && req.method === "GET") return await handleLicence(req);

    // everything below needs a session
    const session = await currentSession(req);
    if (!session) return json({ error: "Unauthorized" }, 401, req);

    if (path === "/api/networks" && req.method === "GET") return await handleNetworks(req, session);
    if (path === "/api/logout" && req.method === "POST") return await handleLogout(req, session);
    if (path === "/api/change-password" && req.method === "POST") {
      return await handleChangePassword(req, session);
    }

    const m = path.match(/^\/api\/network\/([^/]+)(?:\/(users|activity))?$/);
    if (m && req.method === "GET") {
      return await handleNetwork(req, decodeURIComponent(m[1]), m[2], session);
    }

    return json({ error: "Not found" }, 404, req);
  } catch (e) {
    console.error("maktub error", e);
    return json({ error: (e as Error).message || "Server error" }, 500, req);
  }
});
