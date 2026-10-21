// ============================================================
// PatchBay3 — mailbox sync.   Repo path: api/mail.js
//
//   GET /api/mail?key=…            incremental: whatever is new since last time
//   GET /api/mail?key=…&backfill=1 one-off: find every New Job email ever sent and
//                                  fill in the customer contacts
//
// WHAT IT DOES
//   Reads Inbox and Sent Items, decides which job each message belongs to, and
//   records it. A message you SENT on a job's thread is recorded as outbound,
//   which is what stops the Hub needing you to press "Mark sent" — it can see.
//
// WHAT IT DOESN'T
//   Store message bodies. The preview line and a link to the real thing in Outlook
//   are enough to know what happened; keeping customers' correspondence in our
//   database is a liability with no upside.
//
// Env: MS_*, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
// ============================================================

const oauth = require("./oauth.js");
const intake = require("./intake.js");
const graph = oauth.graph;
const parseNewJob = intake.parseNewJob;

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ME = (process.env.PM_EMAIL || "eatkins@code3av.com").toLowerCase();
const MICK = (process.env.SALES_EMAIL || "mburdick@code3av.com").toLowerCase();
// our own people — mail between us is internal, not customer correspondence
const HOUSE = /@code3av\.com$/i;

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
const addr = (x) => (x && x.emailAddress && x.emailAddress.address || "").toLowerCase();
const name = (x) => (x && x.emailAddress && x.emailAddress.name) || null;

/* ---------- which job does this belong to? ----------------------------------
   In priority order, because a later rule being wrong matters less than an
   earlier one being right:
     1. the thread is already linked        — certain
     2. a job number appears in the subject — near certain, and handles ranges
     3. the sender is a job's customer      — a guess, but a good one
     4. nothing                             — say so, don't invent                */
function matchJob(msg, jobs, threads) {
  const t = threads.get(msg.conversationId);
  if (t) return { job_id: t.job_id, by: "thread" };

  const subj = String(msg.subject || "");
  // "Code 3 AV 26231-26255 VA DDS" — a range names every job in it
  const range = subj.match(/\b(\d{5})\s*[-–—]\s*(\d{5})\b/);
  if (range) {
    const lo = +range[1], hi = +range[2];
    if (hi - lo < 100) {
      const hit = jobs.filter((j) => { const n = +j.project_number; return n >= lo && n <= hi; });
      if (hit.length) return { job_id: hit[0].id, by: "number", also: hit.slice(1).map((j) => j.id) };
    }
  }
  const nums = subj.match(/\b\d{5}\b/g) || [];
  for (const n of nums) {
    const j = jobs.find((x) => String(x.project_number) === n);
    if (j) return { job_id: j.id, by: "number" };
  }

  const from = addr(msg.from);
  if (from && !HOUSE.test(from)) {
    const j = jobs.find((x) => String(x.cust_email || "").toLowerCase() === from)
          || jobs.find((x) => String(x.po_email   || "").toLowerCase() === from);
    if (j) return { job_id: j.id, by: "contact" };
  }
  return { job_id: null, by: "none" };
}

/* Mick's New Job announcement — not a reply to one. "Re: New Job 25126 UVA Darden
   Student Housing" is a conversation about a job that was announced weeks ago; it
   carries the same words and none of the structure, and re-parsing it costs a Graph
   call to learn nothing. */
const isReply = (s) => /^\s*(re|fw|fwd|aw|tr)\s*:/i.test(String(s || ""));
const isNewJob = (m) =>
  addr(m.from) === MICK &&
  !isReply(m.subject) &&
  /\bNew Job\b/i.test(String(m.subject || ""));

/* A handoff is Mick writing to people OUTSIDE the company about a specific job —
   that's the thread every later customer email lives on. */
function isHandoff(m) {
  if (addr(m.from) !== MICK) return false;
  const to = (m.toRecipients || []).concat(m.ccRecipients || []).map(addr);
  return to.some((a) => a && !HOUSE.test(a));
}

async function readOne(id) {
  return graph("/me/messages/" + encodeURIComponent(id) +
    "?$select=id,subject,body,from,toRecipients,ccRecipients,conversationId,receivedDateTime");
}

/* ---------- store a message ---------- */
function rowFor(m, dir, match) {
  return {
    id: m.id,
    conversation_id: m.conversationId || null,
    job_id: match.job_id,
    direction: dir,
    subject: m.subject || null,
    from_name: name(m.from),
    from_addr: addr(m.from) || null,
    to_addrs: (m.toRecipients || []).map(addr).filter(Boolean),
    preview: (m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 300) || null,
    has_attach: !!m.hasAttachments,
    sent_at: m.sentDateTime || m.receivedDateTime || null,
    web_link: m.webLink || null,
    matched_by: match.by,
    is_read: m.isRead === undefined ? null : !!m.isRead,
  };
}

const SELECT = "id,subject,bodyPreview,from,toRecipients,ccRecipients,conversationId," +
               "receivedDateTime,sentDateTime,hasAttachments,webLink,isRead";

/* Walk a delta link to the end, collecting messages. Graph hands back a
   deltaLink on the final page — that's what we store to resume next time. */
async function deltaWalk(start, folder) {
  let url = start || ("/me/mailFolders/" + folder + "/messages/delta?$select=" + SELECT);
  const out = []; let guard = 0, next = null;
  while (url && guard++ < 40) {
    const j = await graph(url);
    (j.value || []).forEach((m) => out.push(m));
    if (j["@odata.nextLink"]) { url = j["@odata.nextLink"]; continue; }
    next = j["@odata.deltaLink"] || null;
    break;
  }
  return { messages: out, delta: next };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    const want = String(CRON_SECRET).trim();
    const got  = String(q.key || "").trim();
    const hdr  = String(auth || "").replace(/^Bearer\s+/i, "").trim();
    if (got !== want && hdr !== want) {
      res.status(401).json({ error: "unauthorized" }); return;
    }
  }
  const stat = { seen: 0, matched: 0, unmatched: 0, outbound: 0, newJobs: 0,
                 handoffs: 0, filled: 0, errors: [] };

  let acct;
  try {
    const rows = await sb("mail_account?id=eq.1&select=*");
    acct = rows && rows[0];
    if (!acct || !acct.refresh_token) {
      res.status(200).json({ ok: false, reason: "mailbox not connected — visit /api/oauth" });
      return;
    }
  } catch (e) { res.status(500).json({ error: e.message }); return; }

  // everything we need to decide where a message belongs
  let jobs = [], threads = new Map();
  try {
    jobs = await sb("jobs?select=id,project_number,name,cust_email,po_email,thread_id,cust_name&limit=2000") || [];
    const th = await sb("mail_threads?select=conversation_id,job_id") || [];
    th.forEach((t) => threads.set(t.conversation_id, t));
  } catch (e) { res.status(500).json({ error: e.message }); return; }

  // ══════════════════════════════════════════════════════════════════
  // BACKFILL — every New Job email Mick has ever sent, in one pass
  // ══════════════════════════════════════════════════════════════════
  if (q.backfill === "1") {
    try {
      let url = "/me/messages?$search=" + encodeURIComponent('"from:' + MICK + ' AND subject:New Job"') +
                "&$select=" + SELECT + "&$top=50";
      const seen = [];
      for (let p = 0; p < 10 && url; p++) {
        const j = await graph(url);
        (j.value || []).forEach((m) => seen.push(m));
        url = j["@odata.nextLink"] || null;
      }
      stat.seen = seen.length;
      for (const m of seen) {
        if (!isNewJob(m)) continue;
        stat.newJobs++;
        let full; try { full = await readOne(m.id); } catch (e) { stat.errors.push(m.id); continue; }
        const parsed = parseNewJob({ subject: full.subject,
          html: full.body && full.body.content, text: full.bodyPreview });
        if (!parsed.project_number) continue;
        const job = jobs.find((x) => String(x.project_number) === parsed.project_number);
        if (!job) continue;
        // only fill what's empty — never overwrite something a human has corrected
        const patch = {};
        const put = (k, v) => { if (v && !job[k]) patch[k] = v; };
        put("cust_name", parsed.cust_name); put("cust_first", parsed.cust_first);
        put("cust_title", parsed.cust_title); put("cust_email", parsed.cust_email);
        put("cust_phone", parsed.cust_phone); put("cust_company", parsed.cust_company);
        put("site_address", parsed.site_address);
        put("po_name", parsed.po_name); put("po_email", parsed.po_email);
        put("folder_url", parsed.folder_url); put("folder_name", parsed.folder_name);
        put("scope_text", parsed.scope_text); put("hard_deadline", parsed.hard_deadline);
        put("requested_start", parsed.requested_start);
        put("requested_completion", parsed.requested_completion);
        if (!Object.keys(patch).length) continue;
        patch.intake_at = new Date().toISOString();
        patch.intake_source = "mailbox";
        await sb("jobs?id=eq." + job.id, { method: "PATCH", body: JSON.stringify(patch) });
        Object.assign(job, patch);
        stat.filled++;
      }
      res.status(200).json({ ok: true, backfill: true, ...stat });
    } catch (e) { res.status(500).json({ ok: false, ...stat, error: e.message }); }
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  // INCREMENTAL — what's new since last time
  // ══════════════════════════════════════════════════════════════════
  try {
    const inbox = await deltaWalk(acct.delta_inbox, "inbox");
    const sent  = await deltaWalk(acct.delta_sent,  "sentitems");
    const batch = [];

    for (const [list, dir] of [[inbox.messages, "in"], [sent.messages, "out"]]) {
      for (const m of list) {
        if (!m.id || m["@removed"]) continue;
        stat.seen++;
        const match = matchJob(m, jobs, threads);

        // Mick's handoff email IS the customer thread for that job
        if (dir === "in" && match.job_id && isHandoff(m) && m.conversationId) {
          stat.handoffs++;
          if (!threads.has(m.conversationId)) {
            await sb("mail_threads", { method: "POST", body: JSON.stringify({
              conversation_id: m.conversationId, job_id: match.job_id,
              subject: m.subject || null, matched_by: match.by }) }).catch(() => {});
            threads.set(m.conversationId, { job_id: match.job_id });
            await sb("jobs?id=eq." + match.job_id, { method: "PATCH",
              body: JSON.stringify({ thread_id: m.conversationId }) }).catch(() => {});
          }
        }

        // a New Job email we've never read in fills the job's details
        if (dir === "in" && isNewJob(m)) {
          stat.newJobs++;
          try {
            const full = await readOne(m.id);
            const parsed = parseNewJob({ subject: full.subject,
              html: full.body && full.body.content });
            const job = parsed.project_number &&
              jobs.find((x) => String(x.project_number) === parsed.project_number);
            if (job && !job.cust_email && parsed.cust_email) {
              await sb("jobs?id=eq." + job.id, { method: "PATCH", body: JSON.stringify({
                cust_name: parsed.cust_name, cust_first: parsed.cust_first,
                cust_email: parsed.cust_email, cust_phone: parsed.cust_phone,
                cust_company: parsed.cust_company, site_address: parsed.site_address,
                folder_url: parsed.folder_url, folder_name: parsed.folder_name,
                scope_text: parsed.scope_text, hard_deadline: parsed.hard_deadline,
                requested_start: parsed.requested_start,
                intake_at: new Date().toISOString(), intake_source: "mailbox",
              }) });
              job.cust_email = parsed.cust_email;
              stat.filled++;
            }
          } catch (e) { stat.errors.push("newjob " + m.id); }
        }

        if (match.job_id) stat.matched++; else stat.unmatched++;
        batch.push(rowFor(m, dir, match));

        /* You replying on a job's thread IS the record that you replied. This is
           what retires "Mark sent" — the Hub stops asking you to tell it something
           it can see for itself. */
        if (dir === "out" && match.job_id) {
          stat.outbound++;
          await sb("pm_outbound", { method: "POST", body: JSON.stringify({
            job_id: match.job_id, code: null, subject: m.subject || null,
            sent_at: m.sentDateTime || m.receivedDateTime, sent_by: ME,
            how: "detected", note: "seen in Sent Items",
          }) }).catch(() => {});
        }
      }
    }

    for (let i = 0; i < batch.length; i += 50) {
      await sb("mail_messages?on_conflict=id", { method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(batch.slice(i, i + 50)) }).catch((e) => stat.errors.push(e.message));
    }

    await sb("mail_account?id=eq.1", { method: "PATCH", body: JSON.stringify({
      delta_inbox: inbox.delta || acct.delta_inbox,
      delta_sent:  sent.delta  || acct.delta_sent,
      last_sync: new Date().toISOString(), last_error: null,
    }) });

    res.status(200).json({ ok: true, ...stat });
  } catch (e) {
    await sb("mail_account?id=eq.1", { method: "PATCH",
      body: JSON.stringify({ last_error: String(e.message || e) }) }).catch(() => {});
    res.status(500).json({ ok: false, ...stat, error: String(e.message || e) });
  }
};

module.exports.matchJob = matchJob;
module.exports.isNewJob = isNewJob;
module.exports.isHandoff = isHandoff;
module.exports.rowFor = rowFor;
