// Hive-Notes admin actions: invite new staff, resend an invitation, deactivate / reactivate.
// Only active Hive-Notes admins can call it. Paste this whole file into Supabase → Edge Functions → Deploy a new function → Via Editor, name it hn-admin.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

// ---------- email + helpers (same in both functions) ----------
type Attachment = { filename: string; content: Uint8Array; type?: string };
type Mail = { to: string[]; cc?: string[]; subject: string; text: string; html?: string; attachments?: Attachment[]; replyTo?: string };

const env = (k: string) => Deno.env.get(k) ?? "";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function mailConfigured(): boolean {
  return !!(env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET") && env("MS_SENDER")) || !!env("RESEND_API_KEY");
}

async function sendMail(m: Mail): Promise<void> {
  if (env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET") && env("MS_SENDER")) return sendGraph(m);
  if (env("RESEND_API_KEY")) return sendResend(m);
  throw new Error("Email is not set up on the server (add the RESEND_API_KEY or MS_* secrets).");
}

async function sendResend(m: Mail) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env("MAIL_FROM") || "Hive-Notes <onboarding@resend.dev>",
      to: m.to, cc: m.cc?.length ? m.cc : undefined, reply_to: m.replyTo || undefined,
      subject: m.subject, text: m.text, html: m.html,
      attachments: (m.attachments ?? []).map(a => ({ filename: a.filename, content: b64(a.content) })),
    }),
  });
  if (!r.ok) throw new Error(`Resend: ${r.status} ${await r.text()}`);
}

async function sendGraph(m: Mail) {
  const tok = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!tok.ok) throw new Error(`Microsoft sign-in: ${tok.status} ${await tok.text()}`);
  const { access_token } = await tok.json();
  const addr = (a: string) => ({ emailAddress: { address: a } });
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env("MS_SENDER"))}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: m.subject,
        body: m.html ? { contentType: "HTML", content: m.html } : { contentType: "Text", content: m.text },
        toRecipients: m.to.map(addr), ccRecipients: (m.cc ?? []).map(addr),
        replyTo: m.replyTo ? [addr(m.replyTo)] : [],
        attachments: (m.attachments ?? []).map(a => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.filename, contentType: a.type || "application/octet-stream", contentBytes: b64(a.content) })),
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) throw new Error(`Microsoft 365: ${r.status} ${await r.text()}`);
}

const escHtml = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function htmlWrap(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f9fb;font-family:Segoe UI,Arial,sans-serif;color:#14232b">
<div style="max-width:600px;margin:0 auto;padding:24px">
<div style="background:#00ADEF;color:#0F2A36;padding:14px 18px;border-radius:12px 12px 0 0;font-weight:700;font-size:18px">Hive-Notes</div>
<div style="background:#fff;border:1px solid #d5e2e8;border-top:0;border-radius:0 0 12px 12px;padding:20px 18px;font-size:15px;line-height:1.5">
<h2 style="margin:0 0 12px;font-size:19px">${escHtml(title)}</h2>${bodyHtml}</div>
<p style="font-size:12px;color:#5b6b73;text-align:center">Sent by Hive-Notes</p></div></body></html>`;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Works with both the older service_role key and the newer secret keys (sb_secret_...).
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return keys.default ?? Object.values(keys)[0] as string; } catch { return ""; }
}

// ---------- function ----------

const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });

async function inviteEmail(st: { full_name: string; username: string; email: string }, link: string, appUrl: string, again = false) {
  const first = st.full_name.split(" ")[0];
  const text = `Hi ${first},\n\n${again ? "Here is a new link to" : "You’ve been added to Hive-Notes, Hive’s app for safety plans and site notes. Use this link to"} set your password:\n${link}\n\nYour user name: ${st.username}\n\nAfter that, open ${appUrl} and sign in. On a phone, use “Add to Home Screen” so it opens like an app and works without a signal.\n\nThe link works once and expires in 24 hours. If it has expired, ask your Hive-Notes admin to resend it.`;
  const html = htmlWrap(again ? "Your Hive-Notes link" : "You’ve been added to Hive-Notes", `<p>Hi ${escHtml(first)},</p>
<p>${again ? "Here is a new link to set your Hive-Notes password." : "You’ve been added to Hive-Notes, Hive’s app for safety plans and site notes. It works on your phone and your PC, and offline in the field."}</p>
<p>Your user name: <b>${escHtml(st.username)}</b></p>
<p><a href="${escHtml(link)}" style="display:inline-block;background:#00ADEF;color:#0F2A36;font-weight:700;padding:12px 18px;border-radius:10px;text-decoration:none">Set my password</a></p>
<p>Then open <a href="${escHtml(appUrl)}" style="color:#00729E">${escHtml(appUrl)}</a> and sign in. On a phone, use “Add to Home Screen” so it opens like an app and works without a signal.</p>
<p style="color:#5b6b73;font-size:13px">The link works once and expires in 24 hours. If it has expired, ask your Hive-Notes admin to resend it.</p>`);
  await sendMail({ to: [st.email], subject: again ? "Your Hive-Notes sign-in link" : "You’ve been added to Hive-Notes", text, html });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("hn_staff").select("id, role, active").eq("id", u.user.id).maybeSingle();
    if (!me || me.role !== "admin" || !me.active) return json({ error: "Only Hive-Notes admins can do this" }, 403);

    const body = await req.json();
    const appUrl: string = (Deno.env.get("APP_URL") || body.app_url || "").trim();
    if (!/^https?:\/\//.test(appUrl)) return json({ error: "APP_URL is not set" }, 400);

    if (body.action === "invite") {
      const s = body.staff ?? {};
      const st = {
        username: String(s.username ?? "").trim().toLowerCase(), full_name: String(s.full_name ?? "").trim(), email: String(s.email ?? "").trim().toLowerCase(),
        role: s.role === "admin" ? "admin" : "staff", is_pm: !!s.is_pm, title: s.title ? String(s.title).slice(0, 120) : null,
      };
      if (!/^[a-z0-9._-]{2,40}$/.test(st.username)) return json({ error: "User name must be 2–40 letters, numbers, dots, dashes or underscores" }, 400);
      if (!st.full_name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(st.email)) return json({ error: "Name and a valid email are needed" }, 400);
      const { data: clash } = await admin.from("hn_staff").select("id").or(`username.eq.${st.username},email.eq.${st.email}`).limit(1);
      if (clash?.length) return json({ error: "That user name or email is already on the staff list" }, 409);

      let userId: string, link: string | null = null;
      if (mailConfigured()) {
        // Create the user and an invite link, and send our own branded email.
        const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email: st.email, options: { redirectTo: appUrl } });
        if (error) return json({ error: error.message }, 400);
        userId = data.user.id; link = data.properties.action_link;
      } else {
        // No mail service yet: Supabase sends its own invitation email.
        const { data, error } = await admin.auth.admin.inviteUserByEmail(st.email, { redirectTo: appUrl });
        if (error) return json({ error: error.message }, 400);
        userId = data.user.id;
      }
      const { error: ie } = await admin.from("hn_staff").insert({ id: userId, ...st, invited_at: new Date().toISOString() });
      if (ie) { await admin.auth.admin.deleteUser(userId); return json({ error: ie.message }, 400); }
      if (link) await inviteEmail(st, link, appUrl);
      return json({ ok: true, id: userId });
    }

    const { data: st } = await admin.from("hn_staff").select("*").eq("id", body.id).maybeSingle();
    if (!st) return json({ error: "Staff member not found" }, 404);

    if (body.action === "resend") {
      if (!st.active) return json({ error: "Reactivate this person first" }, 400);
      const { data: au } = await admin.auth.admin.getUserById(st.id);
      const confirmed = !!au?.user?.email_confirmed_at || !!au?.user?.last_sign_in_at;
      if (mailConfigured()) {
        const { data, error } = await admin.auth.admin.generateLink({ type: confirmed ? "recovery" : "invite", email: st.email, options: { redirectTo: appUrl } });
        if (error) return json({ error: error.message }, 400);
        await inviteEmail(st, data.properties.action_link, appUrl, true);
      } else if (confirmed) {
        const { error } = await admin.auth.resetPasswordForEmail(st.email, { redirectTo: appUrl });
        if (error) return json({ error: error.message }, 400);
      } else {
        const { error } = await admin.auth.admin.inviteUserByEmail(st.email, { redirectTo: appUrl });
        if (error) return json({ error: error.message }, 400);
      }
      await admin.from("hn_staff").update({ invited_at: new Date().toISOString() }).eq("id", st.id);
      return json({ ok: true });
    }

    if (body.action === "set_active") {
      if (st.id === me.id) return json({ error: "You can’t deactivate yourself" }, 400);
      const on = !!body.active;
      const { error } = await admin.from("hn_staff").update({ active: on }).eq("id", st.id);
      if (error) return json({ error: error.message }, 400);
      await admin.auth.admin.updateUserById(st.id, { ban_duration: on ? "none" : "876000h" });
      if (!on) await admin.auth.admin.signOut(st.id).catch(() => {});
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
