# Hive-Notes 0.1.0

Hive's central app for notes and forms, on phones, tablets and PCs, with offline mode.
The first section is **Safety: Health & Safety Plan + Hazard Assessment**. It is built from the `Safety_Plan_19-09-30.xlsm` workbook.
Hazmat notes and Phase I ESA notes are shown as "coming later" tiles.

With `hivenotes-config.json` left blank, the app runs in **demo mode**. Demo mode uses made-up people, sends nothing and keeps data in the browser.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png` | Offline support and "Add to Home Screen" |
| `vendor/` | jsPDF 2.5.2 + jsPDF-AutoTable 3.8.2 (MIT) for the PDF, supabase-js 2.119.0 (MIT) for the server connection, so they work offline |
| `hivenotes-config.json` | Server settings (blank = demo mode) |
| `supabase/schema.sql` | Database tables, security rules and PDF storage |
| `supabase/functions/hn-admin/index.ts` | Server function (one paste-in file): invite staff (email with a set-password link), resend, deactivate |
| `supabase/functions/hn-submit/index.ts` | Server function (one paste-in file): emails the submitted PDF to the PM, with a copy to the submitter |
| `logo.png` *(optional, add it yourself)* | If present, replaces the built-in hexagon mark in the app and on the PDF |

## Setup

**Follow the step-by-step guide "Hive-Notes – Supabase setup guide"** (https://claude.ai/artifact/BgcsDcLWyaHkD6pfUnsCZx). Below is the short version.

1. **Supabase project:** create a new project `hive-notes` (Canada Central if offered).
2. **Database:** SQL Editor → New query → paste all of `supabase/schema.sql` → Run.
3. **Auth settings:**
   - Authentication → Sign In / Providers → turn off "Allow new users to sign up".
   - Authentication → URL Configuration → set Site URL and a Redirect URL to the app address.
4. **Email (Resend):**
   - Verify hiveeng.ca in Resend and create an API key.
   - In Supabase, Authentication → Emails → SMTP Settings → enable custom SMTP with host `smtp.resend.com`, port 465, username `resend`, and the API key as the password. Supabase's built-in email only reaches members of your Supabase organization, so password resets need this.
5. **Server functions (no install needed):**
   - Edge Functions → Deploy a new function → Via Editor → paste `supabase/functions/hn-admin/index.ts` → name `hn-admin` → Deploy. Do the same for `hn-submit`.
   - On each function's Details tab, turn **off** "Verify JWT with legacy secret". The functions check sign-in themselves.
   - Edge Functions → Secrets: `APP_URL`, `RESEND_API_KEY`, `MAIL_FROM` (`Hive-Notes <hive-notes@hiveeng.ca>`), `TIME_ZONE` (`America/Halifax`).
   - Microsoft 365 instead of Resend: set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_SENDER` instead. This needs an Entra ID app registration with the Mail.Send application permission.
6. **Config:** fill `hivenotes-config.json`:
   - the Project URL;
   - the **publishable** key (`sb_publishable_…`, or the legacy anon key);
   - the app address.
   Never put the secret or service_role key there.
7. **GitHub Pages:** create the repository `hive-notes`, upload everything in this folder (`supabase/` is optional), then Settings → Pages → deploy from `main`, `/ (root)`.
8. **First admin:**
   - Authentication → Users → Add user (tick Auto Confirm).
   - Sign in to the app with that email and click "Make me the first admin".
   - The starting library, templates, SOP/SWP list and emergency numbers upload on that first sign-in.

### Phones and tablets
Open the app address in Safari (iPhone/iPad) or Chrome (Android), then **Share → Add to Home Screen**.
The first sign-in needs a connection. After that:
- the app opens and works with no signal;
- plans are kept on the device;
- a submitted plan waits in the outbox and sends itself when the connection is back. The top bar shows "Offline · 1 waiting".

## How it works

- **Sign-in:** user name (or email) and password. Admins add and invite staff, resend invitations and deactivate people. A deactivated person can't sign in, and their plans stay. Staff use "Forgot password?" on the sign-in screen.
- **Page 1 – Project info:**
  - project fields from the workbook, and a project manager picked from the staff marked "Project manager";
  - project and subcontractor activities, with the subcontractor declaration and check boxes;
  - accident text;
  - emergency contacts, filled in by picking a community;
  - project contacts;
  - **signature pad** sign-off.
- **Page 2 – Hazard assessment:**
  - **"+ New activity or hazard"** opens the picker, like the workbook's form: Activities on the left, Hazards on the right, with Field / Lab / Office tabs and search. You can pick several at once.
  - Rows fill in the hazard description, responsibility, risk, control measures and residual risk from the library.
  - **Load template** brings in the workbook's seven templates.
  - Risk levels are picked on the workbook's risk matrix (1–4 severity × A–E likelihood → Ext / High / Med / Low).
  - SOP/SWP numbers in the control measures become links.
  - Notes, the violence question, optional crew acknowledgements (each person signs) and a **signature pad** sign-off.
- **Review & submit:**
  - a checklist of anything missing, and the PDF preview;
  - **Submit to PM** builds the PDF (Health & Safety Plan + Hazard Assessment, landscape letter, with signatures and a list of the SOP/SWP documents it references, linked);
  - the PDF is emailed to the PM with a copy to the submitter. The email wording comes from the workbook's Outlook macro.
- **PM:**
  - the plan appears under **Sent to me**, and the email has a link that opens it;
  - **Mark reviewed** locks it. This replaces the workbook's read receipt.
  - The submitter can **Reopen to edit** and resubmit until the plan is reviewed.
- **Admin (PC):**
  - **Activities & hazards library:** an editable table that drives the picker. Untick "In use" to retire a row without deleting it.
  - **SOP / SWP links:** number → title → link. Put the current SharePoint link here; every plan and PDF links to it.
  - **Templates, Emergency numbers, Form wording.**
  - Changes reach everyone on their next sync.

## Security notes
- Row-level security: staff see their own plans, PMs see plans sent to them, and admins see everything. Only the owner (or an admin) can change a plan. A PM can only mark it reviewed. Reviewed plans are locked except for admins.
- PDFs are kept in a private storage bucket, readable only by the owner, the PM and admins.
- The user-name lookup (`hn_login_email`) returns an email only for an active user name.
- There must always be at least one active admin.

## Not tested yet
The database rules were tested on PostgreSQL 16 with stand-ins for Supabase's auth and storage. The app's server code was tested against a stand-in client: sign-in, sync, offline submit with a queued send, and the PM review.
The two server functions were type-checked, and their email payloads were checked with a mock.
None of it has been run against a real Supabase project or real email yet.
