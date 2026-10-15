// ============================================================
// PatchBay3 — make an Outlook draft.   Repo path: api/draft.js
//
//   POST /api/draft  { job_ids:[…], code, subject, body }
//     → creates a DRAFT in Outlook and returns its webLink
//
// WHY A DRAFT AND NOT A SEND
//   The token this uses has no Mail.Send scope, so sending isn't a decision we're
//   choosing not to make — it's one we can't. PatchBay writes the draft into the
//   real thread; you open it, look at it, and press Send yourself.
//
// AUTH
//   The caller is the signed-in browser, so it proves itself with its Supabase
//   session rather than a shared secret in a URL. The token is verified against
//   Supabase and the address checked against PM_EMAIL.
//
// Env: MS_*, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, PM_EMAIL
// ============================================================

const oauth = require("./oauth.js");
const graph = oauth.graph;

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON = process.env.SUPABASE_ANON_KEY || SB_KEY;
const PM = (process.env.PM_EMAIL || "eatkins@code3av.com").toLowerCase();

async function sb(path, opt = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opt, {
    headers: Object.assign({
      apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json", Prefer: "return=representation",
    }, opt.headers || {}),
  }));
  const t = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + t.slice(0, 200));
  try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}

/* Who is asking? Verify the browser's session with Supabase rather than trusting
   anything it tells us about itself. */
async function whoIsAsking(req) {
  const h = req.headers["authorization"] || "";
  const tok = h.replace(/^Bearer\s+/i, "").trim();
  if (!tok) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + tok } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.email || "").toLowerCase() || null;
  } catch (e) { return null; }
}

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* Plain text as it was typed, turned into HTML Outlook will render sensibly.
   [BRACKETS] you haven't filled in are highlighted, so an unfinished draft is
   obvious in Outlook and not just in PatchBay. */
function toHtml(text) {
  return '<div style="font-family:Aptos,Calibri,sans-serif;font-size:11pt">' +
    esc(text).replace(/\[[^\]\n]{1,120}\]/g,
      (m) => '<span style="background:#fff3a3">' + m + "</span>")
      .replace(/\n/g, "<br>") + "</div>";
}

module.exports = async (req, res) => {
  if ((req.method || "GET").toUpperCase() !== "POST") {
    res.status(405).json({ error: "POST only" }); return;
  }
  const who = await whoIsAsking(req);
  if (!who) { res.status(401).json({ error: "sign in first" }); return; }
  if (who !== PM) { res.status(403).json({ error: "not your mailbox" }); return; }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const ids = [].concat(b.job_ids || b.job_id || []).filter(Boolean);
  if (!ids.length || !b.body) {
    res.status(400).json({ error: "send { job_ids, subject, body }" }); return;
  }

  try {
    const jobs = await sb("jobs?id=in.(" + ids.map(encodeURIComponent).join(",") +
      ")&select=id,project_number,name,cust_email,po_email,thread_id,cust_name");
    if (!jobs || !jobs.length) { res.status(404).json({ error: "no such job" }); return; }

    // the thread to reply on, if any of these jobs has one
    const withThread = jobs.find((j) => j.thread_id);
    const to = [...new Set(jobs.map((j) => j.cust_email).filter(Boolean))];
    if (!withThread && !to.length) {
      res.status(400).json({ error: "no thread and no customer address — nowhere to send it" });
      return;
    }

    let draft = null, mode = null;

    if (withThread) {
      /* Reply on the real thread. Graph's createReply hands back a draft whose
         body ALREADY contains the quoted history — so we prepend our text rather
         than replacing the body, or the customer gets a reply with no context. */
      const conv = encodeURIComponent(withThread.thread_id);
      const latest = await graph("/me/messages?$filter=conversationId eq '" + conv +
        "'&$orderby=receivedDateTime desc&$top=1&$select=id,subject");
      const last = latest && latest.value && latest.value[0];
      if (last) {
        draft = await graph("/me/messages/" + encodeURIComponent(last.id) + "/createReply",
          { method: "POST", body: "{}" });
        mode = "reply";
        const quoted = (draft.body && draft.body.content) || "";
        const patch = { body: { contentType: "html",
          content: toHtml(b.body) + "<br><br>" + quoted } };
        // keep Outlook's "RE: …" unless a subject was explicitly supplied
        if (b.subject) patch.subject = b.subject;
        if (to.length) patch.toRecipients = to.map((a) => ({ emailAddress: { address: a } }));
        draft = await graph("/me/messages/" + encodeURIComponent(draft.id),
          { method: "PATCH", body: JSON.stringify(patch) });
      }
    }

    if (!draft) {
      // no thread yet — a fresh draft addressed to the customer
      mode = "new";
      draft = await graph("/me/messages", { method: "POST", body: JSON.stringify({
        subject: b.subject || ("Code 3 AV " + jobs.map((j) => j.project_number).join(", ")),
        body: { contentType: "html", content: toHtml(b.body) },
        toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
      }) });
    }

    /* Deliberately NOT recorded as sent. A draft is not a send — the Hub finds out
       you sent it when it turns up in Sent Items, which is the only evidence that
       means anything. */
    res.status(200).json({ ok: true, mode, id: draft.id,
      webLink: draft.webLink || null,
      to, jobs: jobs.map((j) => j.project_number) });
  } catch (e) {
    const m = String(e.message || e);
    if (/not connected/.test(m)) {
      res.status(409).json({ error: "mailbox not connected", hint: "/api/oauth" }); return;
    }
    res.status(500).json({ error: m });
  }
};

module.exports.toHtml = toHtml;
