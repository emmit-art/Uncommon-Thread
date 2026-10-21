// ============================================================
// PatchBay3 — Microsoft sign-in.   Repo path: api/oauth.js
//
// Two jobs:
//   GET /api/oauth            → send you to Microsoft to sign in
//   GET /api/oauth?code=…     → Microsoft sends you back here; swap the code for
//                               tokens and store the refresh token
//
// DELEGATED, NOT APPLICATION
//   The token this produces carries Emmit's own access and nothing more. It cannot
//   read another mailbox because he can't. And Mail.Send is not among the scopes,
//   so nothing here can put a message in front of a customer — it writes drafts.
//
// Env vars (server-side): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
//                         SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
// ============================================================

const TENANT = process.env.MS_TENANT_ID;
const CLIENT = process.env.MS_CLIENT_ID;
const SECRET = process.env.MS_CLIENT_SECRET;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const SCOPES = "offline_access Mail.ReadWrite User.Read";
const REDIRECT = (req) =>
  "https://" + (req.headers["x-forwarded-host"] || req.headers.host) + "/api/oauth";

const authBase = () => "https://login.microsoftonline.com/" + TENANT + "/oauth2/v2.0";

async function sb(path, opt = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opt, {
    headers: Object.assign({
      apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json", Prefer: "return=representation",
    }, opt.headers || {}),
  }));
  const t = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + t);
  try { return JSON.parse(t); } catch (e) { return null; }
}

/* ---------- the bit every other Graph call uses ----------
   Hand back a valid access token, refreshing when it's within a minute of
   expiring. Microsoft rotates the refresh token on most responses, so whatever
   comes back has to be stored — using a stale one eventually fails and the
   connection appears to break for no reason. */
async function accessToken() {
  const rows = await sb("mail_account?id=eq.1&select=*");
  const acct = rows && rows[0];
  if (!acct || !acct.refresh_token) throw new Error("not connected");

  if (acct.access_token && acct.expires_at &&
      new Date(acct.expires_at).getTime() - Date.now() > 60000) {
    return acct.access_token;
  }

  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET, grant_type: "refresh_token",
    refresh_token: acct.refresh_token, scope: SCOPES,
  });
  const r = await fetch(authBase() + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    await sb("mail_account?id=eq.1", { method: "PATCH", body: JSON.stringify({
      last_error: "refresh failed: " + (j.error_description || j.error || r.status) }) });
    throw new Error("refresh failed: " + (j.error_description || j.error || r.status));
  }
  const patch = {
    access_token: j.access_token,
    expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(),
    last_error: null,
  };
  // rotated token — store it or the next refresh is the one that fails
  if (j.refresh_token) patch.refresh_token = j.refresh_token;
  await sb("mail_account?id=eq.1", { method: "PATCH", body: JSON.stringify(patch) });
  return j.access_token;
}

async function graph(path, opt = {}) {
  const tok = await accessToken();
  const url = /^https?:/.test(path) ? path : "https://graph.microsoft.com/v1.0" + path;
  const r = await fetch(url, Object.assign({}, opt, {
    headers: Object.assign({ Authorization: "Bearer " + tok,
      "Content-Type": "application/json" }, opt.headers || {}),
  }));
  if (r.status === 429) {                       // Graph asked us to slow down
    const wait = Number(r.headers.get("retry-after") || 5);
    await new Promise((s) => setTimeout(s, Math.min(wait, 20) * 1000));
    return graph(path, opt);
  }
  const t = await r.text();
  if (!r.ok) throw new Error("Graph " + r.status + " " + path + ": " + t.slice(0, 300));
  try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}

const page = (title, body, ok) => `<!DOCTYPE html><meta charset="utf-8">
<title>${title}</title><body style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
max-width:560px;margin:14vh auto;padding:0 22px;color:#1f2430">
<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9ca3af;
font-weight:700">PatchBay3</div>
<h1 style="font-size:24px;margin:6px 0 10px;color:${ok ? "#16a34a" : "#dc2626"}">${title}</h1>
${body}
<p style="margin-top:26px"><a href="/#hub" style="color:#2563eb">Back to the Hub</a></p></body>`;

module.exports = async (req, res) => {
  if (!TENANT || !CLIENT || !SECRET) {
    res.status(500).send(page("Not configured",
      "<p>MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET need to be set in Vercel's " +
      "environment variables first.</p>", false));
    return;
  }
  const q = req.query || {};

  // Microsoft rejected it — usually consent not granted yet
  if (q.error) {
    res.status(200).send(page("Microsoft said no",
      `<p><b>${q.error}</b></p><p>${q.error_description || ""}</p>` +
      (/consent|AADSTS65001/i.test(String(q.error_description || q.error))
        ? "<p>That's the admin approval not being in place yet. Once it's granted, " +
          "open this page again.</p>" : ""), false));
    return;
  }

  // ---- step 2: back from Microsoft with a code
  if (q.code) {
    try {
      const body = new URLSearchParams({
        client_id: CLIENT, client_secret: SECRET, grant_type: "authorization_code",
        code: q.code, redirect_uri: REDIRECT(req), scope: SCOPES,
      });
      const r = await fetch(authBase() + "/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const j = await r.json();
      if (!j.refresh_token) throw new Error(j.error_description || j.error || "no refresh token returned");

      // who did we just connect as
      let who = null;
      try {
        const me = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: "Bearer " + j.access_token } }).then((x) => x.json());
        who = me.mail || me.userPrincipalName || null;
      } catch (e) {}

      await sb("mail_account?id=eq.1", { method: "PATCH", body: JSON.stringify({
        email: who, refresh_token: j.refresh_token, access_token: j.access_token,
        expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(),
        connected_at: new Date().toISOString(), last_error: null,
        // a fresh connection starts its delta from scratch
        delta_inbox: null, delta_sent: null,
      }) });

      res.status(200).send(page("Mailbox connected", `<p>Signed in as <b>${who || "your account"}</b>.</p>
        <p>PatchBay will start matching your mail to jobs on the next sync. Nothing is sent
        on your behalf — it prepares drafts and you press Send.</p>`, true));
    } catch (e) {
      res.status(500).send(page("Couldn't finish signing in",
        `<p>${String(e.message || e)}</p>`, false));
    }
    return;
  }

  // ---- disconnect
  if (q.disconnect === "1") {
    if (CRON_SECRET && String(q.key || "").trim() !== String(CRON_SECRET).trim()) {
      res.status(401).send("unauthorized"); return; }
    await sb("mail_account?id=eq.1", { method: "PATCH", body: JSON.stringify({
      refresh_token: null, access_token: null, expires_at: null, email: null,
      delta_inbox: null, delta_sent: null, connected_at: null }) });
    res.status(200).send(page("Disconnected", "<p>The stored token is gone. Mail syncing " +
      "has stopped; nothing else about PatchBay changes.</p>", true));
    return;
  }

  // ---- step 1: off to Microsoft
  const url = authBase() + "/authorize?" + new URLSearchParams({
    client_id: CLIENT, response_type: "code", redirect_uri: REDIRECT(req),
    response_mode: "query", scope: SCOPES, prompt: "select_account",
  }).toString();
  res.writeHead(302, { Location: url });
  res.end();
};

module.exports.accessToken = accessToken;
module.exports.graph = graph;
