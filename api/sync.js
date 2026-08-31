// ============================================================
// Uncommon Thread — Common Thread auto-sync (Vercel serverless cron)
// Repo path: api/sync.js
//
// v4: pulls ONLY jobs in an active CT phase (New Project / ER / Purchasing / Ordered / Install),
// retires anything that moved to Final Invoice or Complete, and keeps jobs with no dates yet.
//
// NOTE: once CT write-access is granted, remove prebuild_date/onsite_date/completion_date from
// the upsert below — PatchBay3 becomes the source of truth for those three and pushes them to CT.
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
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 540);   // wide net: we want every active job
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
// don't touch Common Thread more often than this (minutes) unless ?force=1
const MIN_GAP_MIN = Number(process.env.MIN_GAP_MIN || 120);

// ONLY these CT phases belong on the schedule. Anything else (Final Invoice, Complete,
// Closeout Docs, Under Warranty, Canceled, On Hold…) drops off the Gantt automatically.
// Jobs in these phases are still being scheduled.
const ACTIVE_PHASES = new Set(
  (process.env.ACTIVE_PHASES || "New Project,ER,Purchasing,Ordered,Install")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Phases that mean the work is finished and the hours are effectively final.
const DONE_PHASES = new Set(
  (process.env.DONE_PHASES || "Closeout Docs,Final Invoice,Complete,Under Warranty")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
);
const MAX_MS = 55000;
function todayISO() { return new Date().toISOString().slice(0, 10); }
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
// Budgets are a SCHEDULING input, so they respect hours_manual — a job whose hours
// were set by hand (the kickoff-email backfill) keeps them.
async function sbPatchBudgets(ctId, install, pnc, prog, prebuild, training) {
  const body = { install_hours: install, commissioning_hours: pnc, programming_hours: prog,
                 prebuild_hours: prebuild, training_hours: training };
  const url = SB_URL + "/rest/v1/jobs?ct_project_id=eq." + encodeURIComponent(ctId) + "&hours_manual=eq.false";
  const r = await fetch(url, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("budget patch " + r.status + ": " + (await r.text()));
}
// Actuals and the labor breakdown are REPORTING data — CT is the only source, so they
// always write, even on jobs whose budgets were entered by hand.
async function sbPatchActuals(ctId, actual, byPhase, breakdown, budTotal, actTotal) {
  const body = {};
  if (actual != null) body.actual_hours = actual;
  if (byPhase) {
    body.actual_install       = byPhase.install       || 0;
    body.actual_programming   = byPhase.programming   || 0;
    body.actual_commissioning = byPhase.commissioning || 0;
    body.actual_prebuild      = byPhase.prebuild      || 0;
    body.actual_training      = byPhase.training      || 0;
    body.actual_other         = byPhase.other         || 0;   // engineering, PM, travel…
  }
  if (breakdown) {
    body.labor_ct     = breakdown;          // the full Labor Breakdown table
    body.labor_budget = budTotal || 0;      // every type's budget, incl. engineering/PM/travel
    body.labor_actual = actTotal || 0;
  }
  if (!Object.keys(body).length) return;
  const url = SB_URL + "/rest/v1/jobs?ct_project_id=eq." + encodeURIComponent(ctId);
  const r = await fetch(url, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("actuals patch " + r.status + ": " + (await r.text()));
}
// how long since the last successful pull, in minutes
async function minutesSinceLastRun() {
  try {
    const r = await fetch(SB_URL + "/rest/v1/sync_log?select=ran_at,status&order=ran_at.desc&limit=1", {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY },
    });
    if (!r.ok) return Infinity;
    const rows = await r.json();
    if (!rows.length || !rows[0].ran_at) return Infinity;
    return (Date.now() - Date.parse(rows[0].ran_at)) / 60000;
  } catch (e) { return Infinity; }
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

  // throttle: protects Common Thread from repeated hits. Add &force=1 to override.
  const forced = !!(req.query && (req.query.force === "1" || req.query.force === "true"));
  if (!forced) {
    const gap = await minutesSinceLastRun();
    if (gap < MIN_GAP_MIN) {
      res.status(200).json({ ok: true, skipped: "throttled",
        minutesSinceLastRun: Math.round(gap), minGapMinutes: MIN_GAP_MIN,
        hint: "add &force=1 to run anyway" });
      return;
    }
  }

  const start = Date.now();
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  let total = 0, candidates = 0, opened = 0, kept = 0, skipped = 0, hoursSet = 0, laborSet = 0, retired = 0, capped = false;
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
      const ph = phase.toLowerCase();
      const isLive = ACTIVE_PHASES.has(ph);
      const isDone = DONE_PHASES.has(ph);
      // Finished jobs used to be dropped here, which meant Reports could never see the
      // work we actually completed. Keep them — flagged done so they stay off the chart.
      if (!active && !isDone) { skipped++; continue; }
      if (!isLive && !isDone) { skipped++; continue; }
      // dates are no longer required — a job with none still belongs on the list, flagged
      const pre = onlyDate(det.installStartDate), on = onlyDate(det.onSiteDate), comp = onlyDate(det.expectedCloseDate);
      keepers.push({ id: d.id, det, p: d.p, pre, on, comp, phase, done: isDone });
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
        is_active: !k.done,                 // finished jobs stay in the DB, off the chart
        is_complete: !!k.done,
        completed_at: k.done ? (k.comp || todayISO()) : null,
      };
    });

    // 6) upsert base rows in batches
    kept = rows.length;
    for (let i = 0; i < rows.length; i += 50) await sbUpsert(rows.slice(i, i + 50));

    // 6b) anything CT-linked that is no longer in an active phase drops off the schedule
    if (rows.length) {
      const live = rows.map((r) => r.ct_project_id).join(",");
      const url = SB_URL + "/rest/v1/jobs?ct_project_id=not.is.null&ct_project_id=not.in.(" +
                  encodeURIComponent(live) + ")&is_active=eq.true";
      try {
        const r = await fetch(url, {
          method: "PATCH",
          headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
                     "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ is_active: false }),
        });
        if (r.ok) { const gone = await r.json(); retired = Array.isArray(gone) ? gone.length : 0; }
      } catch (e) { errors.push("retire: " + e.message); }
    }

    // 7) hours from CT's Labor Breakdown (every NEW job has it). Only written where
    //    hours_manual = false, so the one-time email backfill on older jobs is preserved.
    await mapLimit(keepers, CONCURRENCY, async (k) => {
      if (Date.now() - start > MAX_MS) { capped = true; return; }
      let inst = null, pnc = 0, prog = 0, preb = 0, train = 0, actTotal = 0, sawActual = false;
      let budTotal = 0;
      const byPhase = { install:0, programming:0, commissioning:0, prebuild:0, training:0, other:0 };
      const breakdown = [];                 // every labor row exactly as CT reports it
      const labor = (k.p.associations && k.p.associations.projectLabor && k.p.associations.projectLabor.results) || [];
      // Read EVERY labor row. Budgets only come from the scheduled phases, but ACTUAL
      // hours count from all of them — Engineering, Project Management and Travel are
      // real hours spent on the job, and ignoring them made every job look under budget.
      await Promise.all(labor.map(async (l) => {
        const t = (l.title || "").toLowerCase();
        const isPre = t === "pre-build" || t === "prebuild" || t === "pre build";
        try {
          const ld = await ctGet(`/rest/v1/module/2513/${l.id}`);
          const b = Number((ld.details && ld.details.budget) || 0);
          const a = Number((ld.details && ld.details.actual) || 0);
          breakdown.push({ type: l.title || "?", budget: b, actual: a });
          budTotal += b;
          if (a > 0) { actTotal += a; sawActual = true; }        // every labor type
          if (t === "install")            { if (b > 0) inst = b;  byPhase.install       += a; }
          else if (t === "commissioning") { if (b > 0) pnc  = b;  byPhase.commissioning += a; }
          else if (t === "programming")   { if (b > 0) prog = b;  byPhase.programming   += a; }
          else if (t === "training")      { if (b > 0) train= b;  byPhase.training      += a; }
          else if (isPre)                 { if (b > 0) preb = b;  byPhase.prebuild      += a; }
          else                            { byPhase.other += a; }   // engineering, PM, travel…
        } catch (e) {}
      }));
      const act = sawActual ? actTotal : null;
      breakdown.sort((x, y) => (y.budget + y.actual) - (x.budget + x.actual));
      if (inst != null) {                       // only when CT actually has the budget
        try { await sbPatchBudgets(k.id, inst, pnc, prog, preb, train); hoursSet++; }
        catch (e) { errors.push("budget " + k.id + ": " + e.message); }
      }
      if (breakdown.length) {                   // reporting data always lands
        try { await sbPatchActuals(k.id, act, byPhase, breakdown, budTotal, actTotal); laborSet++; }
        catch (e) { errors.push("actuals " + k.id + ": " + e.message); }
      }
    });

    const note = `total ${total}, recent ${candidates}, opened ${opened}, kept ${kept}, hours ${hoursSet}, labor ${laborSet}, retired ${retired}, skipped ${skipped}${capped ? ", CAPPED" : ""}${errors.length ? ", errs " + errors.length : ""}`;
    await sbLog("cron", kept, errors.length ? "ok-with-errors" : "ok", note);
    res.status(200).json({ ok: true, total, recentCandidates: candidates, opened, kept, hoursFromCT: hoursSet, laborFromCT: laborSet, retired, skipped, capped, ms: Date.now() - start, sampleErrors: errors.slice(0, 5) });
  } catch (e) {
    await sbLog("cron", kept, "error", e.message);
    res.status(500).json({ error: e.message, opened, kept });
  }
};
