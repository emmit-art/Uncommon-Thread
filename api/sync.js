// ============================================================
// Uncommon Thread — Common Thread auto-sync (Vercel serverless cron)
// Repo path: api/sync.js
//
// v2: filters by last-modified so it only opens recently-touched
// projects (where all active work lives), instead of all 511.
//
// Env vars (Vercel → Settings → Environment Variables), SERVER-SIDE:
//   CT_API_BASE                 e.g. https://ct.code3av.com
//   CT_API_TOKEN                the read-only Bearer token
//   SUPABASE_URL                https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   the secret service_role key
//   CRON_SECRET                 any random string (protects the endpoint)
//   RECENT_DAYS (optional)      how far back to consider "active" (default 180)
// ============================================================

const CT_BASE = process.env.CT_API_BASE;
const CT_TOKEN = process.env.CT_API_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 180);

const SKIP_PHASES = new Set(["Complete","Canceled","Cancelled","Final Invoice","Under Warranty","Closeout Docs"]);
const MAX_MS = 55000;
const MAX_LIST_PAGES = 12;   // 12 x 100 = up to 1200 projects
const MAX_DETAIL = 350;      // safety cap on how many projects to open per run

const onlyDate = (s) => (s ? String(s).slice(0, 10) : null);

async function ctGet(path) {
  const r = await fetch(CT_BASE + path, { headers: { Authorization: "Bearer " + CT_TOKEN, Accept: "application/json" } });
  if (!r.ok) throw new Error("CT " + path + " -> " + r.status);
  return r.json();
}
async function sbUpsert(rows) {
  if (!rows.length) return;
  const r = await fetch(SB_URL + "/rest/v1/jobs?on_conflict=ct_project_id", {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error("Supabase upsert " + r.status + ": " + (await r.text()));
}
async function sbLog(source, count, status, notes) {
  try {
    await fetch(SB_URL + "/rest/v1/sync_log", {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify([{ source, records_updated: count, status, notes: String(notes || "").slice(0, 500) }]),
    });
  } catch (e) {}
}

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    const key = (req.query && req.query.key) || "";
    if (auth !== "Bearer " + CRON_SECRET && key !== CRON_SECRET) { res.status(401).json({ error: "unauthorized" }); return; }
  }
  if (!CT_BASE || !CT_TOKEN || !SB_URL || !SB_KEY) {
    res.status(500).json({ error: "missing env vars (CT_API_BASE, CT_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)" });
    return;
  }

  const start = Date.now();
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  let total = 0, candidates = 0, scanned = 0, updated = 0, skipped = 0, capped = false;
  const errors = [];
  const batch = [];

  try {
    // 1) gather the full project list (cheap: id + lastModified only)
    let list = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const r = await ctGet(`/rest/v1/module/6?count=100&page=${page}`);
      const results = r.results || r.records || [];
      if (page === 1) total = r.total || 0;
      if (!results.length) break;
      for (const x of results) list.push({ id: x.id, lm: x.lastModified ? Date.parse(x.lastModified) : 0 });
      if (results.length < 100) break;
    }

    // 2) keep only recently-modified projects, newest first
    let recent = list.filter((x) => !x.lm || x.lm >= cutoff).sort((a, b) => b.lm - a.lm);
    candidates = recent.length;
    if (recent.length > MAX_DETAIL) recent = recent.slice(0, MAX_DETAIL);

    // 3) open each candidate and keep the active, schedulable ones
    for (const c of recent) {
      if (Date.now() - start > MAX_MS) { capped = true; break; }
      scanned++;
      let p;
      try { p = await ctGet(`/rest/v1/module/6/${c.id}`); }
      catch (e) { errors.push("proj " + c.id + ": " + e.message); continue; }
      const det = p.details || {};

      const active = det.isActive === 1 || det.isActive === true;
      const phase = det.phase || "";
      if (!active || SKIP_PHASES.has(phase)) { skipped++; continue; }

      const pre = onlyDate(det.installStartDate);
      const on = onlyDate(det.onSiteDate);
      const comp = onlyDate(det.expectedCloseDate);
      if (!pre && !on && !comp) { skipped++; continue; }

      // hours from Project Labor (Install / Commissioning)
      let installHrs = 0, pncHrs = 0, actualHrs = 0;
      const labor = (p.associations && p.associations.projectLabor && p.associations.projectLabor.results) || [];
      for (const l of labor) {
        const t = (l.title || "").toLowerCase();
        if (t !== "install" && t !== "commissioning") continue;
        try {
          const ld = await ctGet(`/rest/v1/module/2513/${l.id}`);
          const b = Number((ld.details && ld.details.budget) || 0);
          const a = Number((ld.details && ld.details.actual) || 0);
          if (t === "install") { installHrs = b; actualHrs = a; } else { pncHrs = b; }
        } catch (e) {}
      }

      const gearIn = det.gearReceived === 1 || det.gearReceived === true;
      const received = gearIn ? (comp || on || null) : null;

      batch.push({
        ct_project_id: String(c.id),
        name: det.displayName || p.title || det.name || ("Project " + c.id),
        location: (det.clientCompanyID && det.clientCompanyID.title) || null,
        ct_phase: phase,
        pm_owner: (det.projectManagerID && det.projectManagerID.title) || null,
        prebuild_date: pre,
        onsite_date: on,
        completion_date: comp,
        install_hours: Math.round(installHrs),
        commissioning_hours: Math.round(pncHrs),
        actual_hours: Math.round(actualHrs),
        eta_date: null,               // ETA (☆) sourcing TBD — added later
        received_date: received,
        is_active: true,
      });
      if (batch.length >= 50) { await sbUpsert(batch.splice(0)); updated += 50; }
    }

    if (batch.length) { updated += batch.length; await sbUpsert(batch); }

    const note = `total ${total}, recent ${candidates}, opened ${scanned}, kept ${updated}, skipped ${skipped}${capped ? ", CAPPED(time)" : ""}${errors.length ? ", errs: " + errors.slice(0, 3).join(" | ") : ""}`;
    await sbLog("cron", updated, errors.length ? "ok-with-errors" : "ok", note);
    res.status(200).json({ ok: true, total, recentCandidates: candidates, opened: scanned, kept: updated, skipped, capped, sampleErrors: errors.slice(0, 5) });
  } catch (e) {
    await sbLog("cron", updated, "error", e.message);
    res.status(500).json({ error: e.message, opened: scanned, kept: updated });
  }
};
