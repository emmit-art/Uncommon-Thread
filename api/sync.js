// ============================================================
// Uncommon Thread — Common Thread auto-sync (Vercel serverless cron)
// Repo path: api/sync.js
//
// v3: opens projects in PARALLEL (fast) and filters by last-modified,
// so it covers every active project in one quick pass, no timeout.
//
// Env vars (Vercel → Settings → Environment Variables), SERVER-SIDE:
//   CT_API_BASE, CT_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
//   RECENT_DAYS (optional, default 180)   CONCURRENCY (optional, default 8)
// ============================================================

const CT_BASE = process.env.CT_API_BASE;
const CT_TOKEN = process.env.CT_API_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 180);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

// phases to leave OFF the schedule; override in Vercel with SKIP_PHASES="Complete,Canceled,Closeout Docs"
const SKIP_PHASES = new Set((process.env.SKIP_PHASES || "Complete,Canceled,Cancelled").split(",").map((s) => s.trim()).filter(Boolean));
const MAX_MS = 55000;
const MAX_LIST_PAGES = 12;

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
// PATCH hours only for rows that aren't hand-locked (hours_manual=false)
async function sbPatchHours(ctId, install, pnc, actual) {
  const body = { install_hours: install, commissioning_hours: pnc };
  if (actual != null) body.actual_hours = actual;
  const url = SB_URL + "/rest/v1/jobs?ct_project_id=eq." + encodeURIComponent(ctId) + "&hours_manual=eq.false";
  const r = await fetch(url, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("hours patch " + r.status + ": " + (await r.text()));
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
// run async fn over items with limited concurrency
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
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
  let total = 0, candidates = 0, opened = 0, kept = 0, skipped = 0, hoursSet = 0, capped = false;
  const errors = [];

  try {
    // 1) full project list (id + lastModified only)
    let list = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const r = await ctGet(`/rest/v1/module/6?count=100&page=${page}`);
      const results = r.results || r.records || [];
      if (page === 1) total = r.total || 0;
      if (!results.length) break;
      for (const x of results) list.push({ id: x.id, lm: x.lastModified ? Date.parse(x.lastModified) : 0 });
      if (results.length < 100) break;
    }

    // 2) recently-modified only, newest first
    const recent = list.filter((x) => !x.lm || x.lm >= cutoff).sort((a, b) => b.lm - a.lm);
    candidates = recent.length;

    // 3) open all candidates IN PARALLEL
    const details = await mapLimit(recent, CONCURRENCY, async (c) => {
      if (Date.now() - start > MAX_MS) { capped = true; return null; }
      try { return { id: c.id, p: await ctGet(`/rest/v1/module/6/${c.id}`) }; }
      catch (e) { errors.push("proj " + c.id + ": " + e.message); return null; }
    });

    // 4) filter to active + schedulable
    const keepers = [];
    for (const d of details) {
      if (!d) continue;
      opened++;
      const det = d.p.details || {};
      const active = det.isActive === 1 || det.isActive === true;
      const phase = det.phase || "";
      if (!active || SKIP_PHASES.has(phase)) { skipped++; continue; }
      const pre = onlyDate(det.installStartDate), on = onlyDate(det.onSiteDate), comp = onlyDate(det.expectedCloseDate);
      if (!pre && !on && !comp) { skipped++; continue; }
      keepers.push({ id: d.id, det, p: d.p, pre, on, comp, phase });
    }

    // 5) build rows. NOTE: hours are intentionally NOT sent here — they come from the
    // kickoff-email backfill / manual entry, and leaving them out of this payload means
    // the sync never overwrites them. This sync now owns dates, phase, client, received.
    const rows = keepers.map((k) => {
      const det = k.det;
      const gearIn = det.gearReceived === 1 || det.gearReceived === true;
      return {
        ct_project_id: String(k.id),
        project_number: det.customID || null,   // e.g. "26152" — matches kickoff emails
        name: det.displayName || k.p.title || det.name || ("Project " + k.id),
        location: (det.clientCompanyID && det.clientCompanyID.title) || null,
        ct_phase: k.phase,
        pm_owner: (det.projectManagerID && det.projectManagerID.title) || null,
        prebuild_date: k.pre,
        onsite_date: k.on,
        completion_date: k.comp,
        received_date: gearIn ? (k.comp || k.on || null) : null,
        is_active: true,
      };
    });

    // 6) upsert base rows in batches
    kept = rows.length;
    for (let i = 0; i < rows.length; i += 50) await sbUpsert(rows.slice(i, i + 50));

    // 7) hours from CT's Labor Breakdown (every NEW job has it). Only written where
    //    hours_manual = false, so the one-time email backfill on older jobs is preserved.
    await mapLimit(keepers, CONCURRENCY, async (k) => {
      if (Date.now() - start > MAX_MS) { capped = true; return; }
      let inst = null, pnc = 0, act = null;
      const labor = (k.p.associations && k.p.associations.projectLabor && k.p.associations.projectLabor.results) || [];
      await Promise.all(labor.map(async (l) => {
        const t = (l.title || "").toLowerCase();
        if (t !== "install" && t !== "commissioning") return;
        try {
          const ld = await ctGet(`/rest/v1/module/2513/${l.id}`);
          const b = Number((ld.details && ld.details.budget) || 0);
          const a = Number((ld.details && ld.details.actual) || 0);
          if (t === "install") { if (b > 0) inst = b; if (a > 0) act = a; }
          else if (b > 0) pnc = b;
        } catch (e) {}
      }));
      if (inst != null) {                       // only when CT actually has the hours
        try { await sbPatchHours(k.id, inst, pnc, act); hoursSet++; }
        catch (e) { errors.push("hours " + k.id + ": " + e.message); }
      }
    });

    const note = `total ${total}, recent ${candidates}, opened ${opened}, kept ${kept}, hours ${hoursSet}, skipped ${skipped}${capped ? ", CAPPED" : ""}${errors.length ? ", errs " + errors.length : ""}`;
    await sbLog("cron", kept, errors.length ? "ok-with-errors" : "ok", note);
    res.status(200).json({ ok: true, total, recentCandidates: candidates, opened, kept, hoursFromCT: hoursSet, skipped, capped, ms: Date.now() - start, sampleErrors: errors.slice(0, 5) });
  } catch (e) {
    await sbLog("cron", kept, "error", e.message);
    res.status(500).json({ error: e.message, opened, kept });
  }
};
