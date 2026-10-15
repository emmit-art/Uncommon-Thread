// ============================================================
// PatchBay3 — New Job email intake.   Repo path: api/intake.js
//
// Mick's New Job emails are rigidly structured, so this is a parse, not a guess.
// There is ONE parser and two ways to reach it:
//
//   POST /api/intake  { subject, html }        ← a Power Automate flow, later
//   POST /api/intake  { subject, text, dry:1 } ← the paste box in the app
//
// `dry:1` parses and returns what it found WITHOUT writing anything, so the paste
// box can show you the fields and let you confirm before they land on the job.
//
// Env vars (server-side): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
// ============================================================

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTAKE_SECRET = process.env.CRON_SECRET;

/* ---------- HTML → text, keeping the two things that matter ----------
   Outlook sends HTML. We flatten it to one line per paragraph, turn the labor
   table into "Label<tab>Hours" lines, and keep each link as "text <url>" so the
   project-folder URL survives. A plain-text paste skips all of this and is parsed
   exactly the same way afterwards. */
function htmlToText(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // The project folder link: keep the anchor text AND the href. NOT in <angle
  // brackets> — the tag stripper below would eat it as if it were a tag, which is
  // exactly what it did the first time round.
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (m, href, txt) => {
      const t = txt.replace(/<[^>]+>/g, "").trim();
      if (/^mailto:/i.test(href)) return t || href.replace(/^mailto:/i, "");
      return t ? `${t} [[${href}]]` : `[[${href}]]`;
    });
  // Table cells hold their own <p>, so flatten inside the cell before the general
  // paragraph rule turns every one of them into its own line and splits the
  // "Install" label away from its "56".
  s = s.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi,
    (m, cell) => cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\t");
  s = s.replace(/<\/t[dh]\s*>/gi, "\t");
  s = s.replace(/<\/tr\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|table)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  // entities we actually meet: &nbsp; &amp; &quot; &#39; &rsquo; and the zero-width
  // space Outlook sprinkles around the folder link
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#3[49];/g, "'")
       .replace(/&rsquo;/gi, "'").replace(/&ldquo;|&rdquo;/gi, '"')
       .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(+n); } catch (e) { return " "; } })
       .replace(/[​‎‏﻿]/g, "");
  s = s.replace(/\r/g, "").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/* Mick's signature block is noise and contains HIS phone and email, which would
   otherwise be picked up as the customer's. Cut everything from the sign-off down. */
function stripSignature(text) {
  const cut = text.search(/\n\s*(Sincerely|Thanks|Thank you|Regards|Best)\s*,?\s*\n/i);
  return cut > 0 ? text.slice(0, cut) : text;
}

const RE_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const RE_PHONE = /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/;

/* "John T. Smith Jr., Instructional and AV Event Support Supervisor, 804-523-5909 (office)
    or 804-388-6739, jsmith@reynolds.edu"  →  {name,title,phone,email}
   Split on commas, then sort the pieces by what they look like rather than by
   position — the title is optional and the phone count varies. */
function parseContact(chunk) {
  if (!chunk) return null;
  const raw = chunk.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
  if (!raw) return null;
  const out = { name: null, title: null, phone: null, email: null };
  const em = raw.match(RE_EMAIL); if (em) out.email = em[0];
  const ph = raw.match(RE_PHONE); if (ph) out.phone = ph[0].trim();

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const isPhone = (p) => RE_PHONE.test(p) || /^\(?\d/.test(p);
  const isEmail = (p) => RE_EMAIL.test(p);
  // the name is the first piece that is neither a phone nor an email. "Jr." and
  // "III" arrive as their own comma piece, so glue a short suffix back on.
  const SUFFIX = /^(jr|sr|ii|iii|iv|md|phd)\.?$/i;
  for (let i = 0; i < parts.length; i++) {
    if (isPhone(parts[i]) || isEmail(parts[i])) continue;
    out.name = parts[i];
    if (parts[i + 1] && SUFFIX.test(parts[i + 1])) { out.name += ", " + parts[i + 1]; i++; }
    // the next non-phone, non-email piece is the title, if there is one
    for (let j = i + 1; j < parts.length; j++) {
      if (isPhone(parts[j]) || isEmail(parts[j])) continue;
      if (SUFFIX.test(parts[j])) continue;
      out.title = parts[j]; break;
    }
    break;
  }
  // a name that is really just the email (no comma form) shouldn't become a name
  if (out.name && isEmail(out.name)) out.name = null;
  return (out.name || out.email || out.phone) ? out : null;
}

function firstName(full) {
  if (!full) return null;
  // "A. C. Whitlow" → "A.C."  is wrong as a greeting; prefer the first word that
  // isn't a single initial. "John T. Smith Jr." → "John". "A. C. Whitlow" → "A.C."
  const words = String(full).split(",")[0].trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const initials = words.filter((w) => /^[A-Z]\.?$/.test(w));
  if (initials.length >= 2 && initials.length >= words.length - 1)
    return initials.join("").replace(/\.$/, "") + ".";   // "A. C. Whitlow" → "A.C."
  return words[0].replace(/[.,]$/, "");
}

const LABOR_KEYS = {
  install: "install_hours", engineering: "engineering_hours", pm: "pm_hours",
  programming: "programming_hours", commissioning: "commissioning_hours",
  training: "training_hours", "pre-build": "prebuild_hours", prebuild: "prebuild_hours",
  travel: "travel_hours",
};

function parseNewJob(input) {
  const subject = String(input.subject || "");
  const text0 = input.html ? htmlToText(input.html) : String(input.text || "");
  const text = stripSignature(text0);
  const flat = text.replace(/\n+/g, " ").replace(/\s+/g, " ");
  const out = { ok: false, warnings: [] };

  // ---- job number: "[26142] New Job …" or "New Job - 24186 …" or "New Job 25316 …"
  let m = subject.match(/\[\s*(\d{4,6})\s*\]/) ||
          subject.match(/New Job\s*[-–—:]?\s*(\d{4,6})\b/i) ||
          flat.match(/\b(\d{5})\b/);
  out.project_number = m ? m[1] : null;
  if (!out.project_number) out.warnings.push("No job number found in the subject.");

  // ---- name: whatever follows the number in the subject
  out.name = subject.replace(/^\s*\[\s*\d{4,6}\s*\]\s*/, "")
                    .replace(/^\s*New Job\s*[-–—:]?\s*/i, "")
                    .replace(/^\s*\d{4,6}\s*[-–—]?\s*/, "").trim() || null;

  // ---- "…for <COMPANY>. This project is located at <ADDRESS>."
  // Addresses are full of full stops ("600 E. Main St., Richmond, VA 23219"), so
  // stopping at the first one gives you "600 E". Run to the ZIP instead, which
  // every one of these has, and only fall back to sentence-cutting without one.
  const addr = flat.match(/This project is located at\s+(.+?\d{5}(?:-\d{4})?)\s*\./i)
            || flat.match(/This project is located at\s+([^.]+)\./i);
  if (addr) out.site_address = addr[1].trim();
  else out.warnings.push("No site address found.");
  m = flat.match(/\bfor\s+(?:the\s+)?([^.]+?)\.\s*This project is located at/i);
  if (m) out.cust_company = m[1].trim();
  else {
    const c = flat.match(/\bfor\s+(?:the\s+)?([A-Z][^.]{2,60}?)\.\s/);
    if (c) out.cust_company = c[1].trim();
  }

  // ---- scope: the first sentence of "Please proceed with this new job to …"
  m = flat.match(/Please proceed with this new job to\s+([^.]+?)\.\s/i);
  out.summary = m ? m[1].trim() : null;

  // ---- requested dates + any hard deadline sitting in the same paragraph
  const req = text.split("\n").find((l) => /Client is requesting/i.test(l)) || "";
  if (req) {
    const s = req.match(/install start (?:time )?of\s+([^.]+?)(?:\s+with completion|\.)/i);
    out.requested_start = s ? s[1].trim() : null;
    const c = req.match(/completion of this project expected to be\s+([^.]+?)\./i);
    out.requested_completion = c ? c[1].trim() : null;
    // anything after the first sentence is the real-world deadline, and it matters
    const rest = req.replace(/^[^.]*\.\s*/, "").trim();
    if (rest) out.hard_deadline = rest;
  }

  // ---- contacts. Everything between "Client contact info:" and the next section.
  m = text.match(/Client contact info:\s*([\s\S]*?)(?:\n\s*\n|\nThe project folder|\nProject information|$)/i);
  if (m) {
    let block = m[1].replace(/\n/g, " ").trim();
    const split = block.split(/PO requestor(?:\s+and delivery contact)?:?\s*/i);
    const client = parseContact(split[0]);
    if (client) {
      out.cust_name = client.name; out.cust_title = client.title;
      out.cust_email = client.email; out.cust_phone = client.phone;
      out.cust_first = firstName(client.name);
    }
    if (split[1]) {
      const po = parseContact(split[1]);
      if (po) { out.po_name = po.name; out.po_email = po.email; out.po_phone = po.phone; }
    }
  }
  if (!out.cust_email) out.warnings.push("No customer email found — the drafts will not know who to greet.");

  // ---- project folder. The NAME is in the sentence; the URL only survives HTML.
  m = text.match(/moved from Hot Leads to\s+(.+?)\s+in the\s+[^\n]*?folder/i);
  if (m) out.folder_name = m[1].trim();
  m = text.match(/\[\[(https?:\/\/[^\]\s]+)\]\]/);
  if (m) out.folder_url = m[1];
  else if (input.html) out.warnings.push("No project folder link found.");

  // ---- the long "Project information:" paragraph
  m = text.match(/Project information:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  out.scope_text = m ? m[1].replace(/\n/g, " ").replace(/\s+/g, " ").trim() : null;

  // ---- the two yes/no flags Mick always states
  const needFlag = (re) => {
    const line = text.split("\n").find((l) => re.test(l));
    if (!line) return null;
    return /\bis not needed\b|\bnot required\b/i.test(line) ? false : true;
  };
  out.kickoff_needed = needFlag(/internal kickoff meeting/i);
  out.gui_needed     = needFlag(/GUI review/i);

  // ---- labor breakdown table → hours per phase
  // Tolerant on purpose: a pasted table may arrive tab-separated, or as a label on
  // one line and its number on the next. Walk the tokens and pair them up.
  const hours = {};
  const after = text.split(/Labor Breakdown/i)[1] || "";
  const toks = after.split(/[\t\n]/).map((x) => x.trim()).filter((x) => x !== "");
  for (let i = 0; i < toks.length; i++) {
    const key = LABOR_KEYS[toks[i].toLowerCase()];
    if (!key) continue;
    const n = parseFloat(toks[i + 1]);
    // only if the very next token is a bare number — "Programming" followed by
    // "Commissioning" means programming was left blank, not that it inherits
    if (!isNaN(n) && /^\d+(\.\d+)?$/.test(toks[i + 1])) { hours[key] = n; i++; }
  }
  out.hours = hours;
  if (!Object.keys(hours).length && /Labor Breakdown/i.test(text))
    out.warnings.push("Found the Labor Breakdown heading but no hours — paste the HTML version to capture the table.");

  out.ok = !!(out.project_number && (out.cust_email || out.cust_name));
  return out;
}

/* ---------- writing it to the job ---------- */
async function sb(path, opt = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opt, {
    headers: Object.assign({
      apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json", Prefer: "return=representation",
    }, opt.headers || {}),
  }));
  const body = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + body);
  try { return JSON.parse(body); } catch (e) { return null; }
}

function jobPatch(p) {
  // Only the fields the email actually told us. Hours are deliberately NOT written
  // here — the sync leaves hours alone on purpose (hours_manual), and a kickoff
  // email is not the place to silently overwrite a budget. They are returned so
  // the app can show them and you can apply them yourself.
  const patch = {};
  const put = (k, v) => { if (v !== null && v !== undefined && v !== "") patch[k] = v; };
  put("cust_name", p.cust_name); put("cust_first", p.cust_first);
  put("cust_title", p.cust_title); put("cust_email", p.cust_email);
  put("cust_phone", p.cust_phone); put("cust_company", p.cust_company);
  put("site_address", p.site_address);
  put("po_name", p.po_name); put("po_email", p.po_email); put("po_phone", p.po_phone);
  put("folder_url", p.folder_url); put("folder_name", p.folder_name);
  put("scope_text", p.scope_text); put("hard_deadline", p.hard_deadline);
  put("requested_start", p.requested_start); put("requested_completion", p.requested_completion);
  if (p.kickoff_needed !== null && p.kickoff_needed !== undefined) patch.kickoff_needed = p.kickoff_needed;
  if (p.gui_needed !== null && p.gui_needed !== undefined) patch.gui_needed = p.gui_needed;
  return patch;
}

module.exports = async (req, res) => {
  if (INTAKE_SECRET) {
    const auth = req.headers["authorization"] || "";
    const key = (req.query && req.query.key) || "";
    if (auth !== "Bearer " + INTAKE_SECRET && key !== INTAKE_SECRET) {
      res.status(401).json({ error: "unauthorized" }); return;
    }
  }
  /* Three shapes, because the sender decides which is easiest for them:
       {subject, html}  — JSON, what you'd send from code
       {subject, text}  — JSON, a plain-text paste
       raw text body    — a "Subject: …" first line, then the email

     The third exists for Power Automate. Building a JSON body there means hand-
     escaping quotes and newlines out of the email, which breaks the first time
     somebody writes 85" display — and Mick's emails are full of both. Posting the
     thing as text/plain sidesteps the whole problem. */
  let b = req.body;
  if (typeof b === "string") {
    const raw = b;
    try { b = JSON.parse(raw); }
    catch (e) {
      const m = raw.match(/^\s*Subject:\s*(.*)$/mi);
      b = { subject: m ? m[1].trim() : "", text: raw.replace(/^\s*Subject:.*$/mi, "").trim() };
      // Power Automate sends the HTML body of an email even as text/plain
      if (/<\w+[^>]*>/.test(b.text)) { b.html = b.text; delete b.text; }
    }
  }
  b = b || {};
  if (!b.subject && !b.html && !b.text) {
    res.status(400).json({ error: "send { subject, html }, { subject, text }, or a text/plain body starting with 'Subject: …'" });
    return;
  }

  let parsed;
  try { parsed = parseNewJob(b); }
  catch (e) { res.status(500).json({ error: "parse failed: " + e.message }); return; }

  // dry run: the paste box shows you what it found before anything is written
  if (b.dry || !SB_URL || !SB_KEY) { res.status(200).json({ parsed, written: false }); return; }
  if (!parsed.project_number) {
    res.status(200).json({ parsed, written: false, reason: "no job number" }); return;
  }

  try {
    // match on project_number — the number Common Thread also stores
    const found = await sb("jobs?project_number=eq." + encodeURIComponent(parsed.project_number) +
                           "&select=id,name,cust_email,project_number");
    if (!found || !found.length) {
      res.status(200).json({ parsed, written: false,
        reason: "no job with number " + parsed.project_number + " yet — it syncs from Common Thread first" });
      return;
    }
    const job = found[0];
    const patch = jobPatch(parsed);
    patch.intake_at = new Date().toISOString();
    patch.intake_source = b.source || "api";

    // 1A vs 1B: have we worked with this email domain before?
    if (parsed.cust_email) {
      const dom = parsed.cust_email.split("@")[1];
      if (dom) {
        const prior = await sb("jobs?cust_email=ilike." + encodeURIComponent("%@" + dom) +
                               "&id=neq." + job.id + "&select=id&limit=1");
        patch.cust_returning = !!(prior && prior.length);
      }
    }
    await sb("jobs?id=eq." + job.id, { method: "PATCH", body: JSON.stringify(patch) });
    res.status(200).json({ parsed, written: true, job_id: job.id, job: job.name, fields: Object.keys(patch) });
  } catch (e) {
    res.status(500).json({ parsed, written: false, error: e.message });
  }
};

module.exports.parseNewJob = parseNewJob;
module.exports.htmlToText = htmlToText;
module.exports.parseContact = parseContact;
module.exports.firstName = firstName;
