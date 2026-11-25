// Hive-Notes: email a submitted safety plan (PDF attached) to its project manager, with a copy to the person who submitted it.
// Called by the app right after it uploads the PDF. Paste this whole file into Supabase → Edge Functions → Deploy a new function → Via Editor, name it hn-submit.
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
const DEFAULT_BODY = "Please review the attached Safety Plan. Ensure all information is valid and that Hazard Assessment control measures are implemented prior to commencement of all work activities. Please indicate if implementation of control measures are impeded in any way.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let noteId = "";
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u.user) return json({ error: "Not signed in" }, 401);

    const body = await req.json();
    noteId = String(body.note_id ?? "");
    const { data: n } = await admin.from("hn_notes").select("*").eq("id", noteId).maybeSingle();
    if (!n) return json({ error: "Plan not found" }, 404);
    if (n.owner !== u.user.id) return json({ error: "Only the person who submitted the plan can send it" }, 403);
    if (n.status !== "submitted") return json({ error: "The plan is not submitted" }, 400);
    if (!n.pm) return json({ error: "No project manager chosen" }, 400);
    if (!n.pdf_path) return json({ error: "The PDF has not been uploaded" }, 400);

    const { data: people } = await admin.from("hn_staff").select("id, full_name, email, active").in("id", [n.owner, n.pm]);
    const owner = people?.find(p => p.id === n.owner), pm = people?.find(p => p.id === n.pm);
    if (!owner?.active) return json({ error: "Your account is not active" }, 403);
    if (!pm?.active) return json({ error: "The chosen project manager is not active in Hive-Notes" }, 400);

    const { data: file, error: fe } = await admin.storage.from("hn-pdfs").download(n.pdf_path);
    if (fe || !file) return json({ error: "Could not read the PDF: " + (fe?.message ?? "missing") }, 400);
    const pdf = new Uint8Array(await file.arrayBuffer());

    const { data: cfg } = await admin.from("hn_config").select("data").eq("key", "texts").maybeSingle();
    const intro: string = (cfg?.data as Record<string, string> | null)?.emailBody || DEFAULT_BODY;
    const d = (n.data ?? {}) as Record<string, unknown>;
    const title = String(d.title ?? n.title ?? "Safety plan"), no = String(d.projectNo ?? n.project_no ?? "");
    const appUrl = (Deno.env.get("APP_URL") || "").replace(/\/$/, "");
    const link = appUrl ? `${appUrl}/?note=${n.id}` : "";
    const when = new Date(n.submitted_at ?? Date.now()).toLocaleString("en-CA", { timeZone: Deno.env.get("TIME_ZONE") || "America/Halifax", dateStyle: "medium", timeStyle: "short" });
    const rows = Array.isArray(d.rows) ? (d.rows as Record<string, string>[]) : [];
    const date = (n.submitted_at ?? new Date().toISOString()).slice(2, 10);
    const filename = `${title} - ${no} - Safety Plan ${date}.pdf`.replace(/[\\/:*?"<>|]/g, "-");
    const violence = d.violence === true;

    const text = `${intro}\n\nProject: ${title} (${no})\nLocation: ${d.address ?? ""}\nSubmitted by ${owner.full_name} on ${when}.\n${rows.length} activities / hazards assessed.${violence ? "\nHeightened risk of violence: YES – follow up with the safety coordinator." : ""}${link ? `\n\nOpen in Hive-Notes (to mark it reviewed): ${link}` : ""}`;
    const html = htmlWrap(`${title} – ${no} – Safety Plan`, `<p>${escHtml(intro)}</p>
<table style="font-size:14px;border-collapse:collapse"><tr><td style="color:#5b6b73;padding:2px 12px 2px 0">Project</td><td><b>${escHtml(title)}</b> (${escHtml(no)})</td></tr>
<tr><td style="color:#5b6b73;padding:2px 12px 2px 0">Location</td><td>${escHtml(String(d.address ?? ""))}</td></tr>
<tr><td style="color:#5b6b73;padding:2px 12px 2px 0">Submitted by</td><td>${escHtml(owner.full_name)}, ${escHtml(when)}</td></tr>
<tr><td style="color:#5b6b73;padding:2px 12px 2px 0">Hazards</td><td>${rows.length} assessed</td></tr></table>
${violence ? `<p style="background:#fff4f4;border-left:4px solid #C62828;padding:8px 12px;font-weight:700;color:#9b1c1c">Heightened risk of violence: YES – follow up with the safety coordinator.</p>` : ""}
${link ? `<p><a href="${escHtml(link)}" style="display:inline-block;background:#00ADEF;color:#0F2A36;font-weight:700;padding:12px 18px;border-radius:10px;text-decoration:none">Open in Hive-Notes</a></p><p style="color:#5b6b73;font-size:13px">Open it in Hive-Notes to mark it reviewed. The PDF is attached.</p>` : "<p>The PDF is attached.</p>"}`);

    await sendMail({ to: [pm.email], cc: owner.email !== pm.email ? [owner.email] : [], replyTo: owner.email, subject: `${title} - ${no} - Safety Plan`, text, html, attachments: [{ filename, content: pdf, type: "application/pdf" }] });
    const emailed_at = new Date().toISOString();
    await admin.from("hn_notes").update({ emailed_at, email_error: null }).eq("id", n.id);
    return json({ ok: true, emailed_at });
  } catch (e) {
    const msg = (e as Error).message;
    if (noteId) await admin.from("hn_notes").update({ email_error: msg.slice(0, 500) }).eq("id", noteId);
    return json({ error: msg }, 500);
  }
});
