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
// Finished work older than this isn't worth keeping or re-reading.
const DONE_MONTHS = Number(process.env.DONE_MONTHS || 12);
// Per run, how many already-finished jobs to backfill labor for. Keeps the call
// volume to Common Thread sane — the backlog fills in over a few runs.
const LABOR_BACKFILL = Number(process.env.LABOR_BACKFILL || 40);
// Ship dates cost one call PER LINE ITEM — there's no bulk endpoint. So we refresh a
// job's ship dates every ETA_STALE_DAYS rather than every run, oldest first, and only
// this many jobs per run. Gear already received? We stop asking entirely.
const ETA_JOBS_PER_RUN = Number(process.env.ETA_JOBS_PER_RUN || 12);
const ETA_STALE_DAYS   = Number(process.env.ETA_STALE_DAYS || 3);
const ETA_MAX_ITEMS    = Number(process.env.ETA_MAX_ITEMS || 60);   // guard against huge jobs

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
async function sbPatchEta(ctId, latest, dated, total) {
  const body = { eta_date: latest, eta_items_dated: dated, eta_items_total: total,
                 eta_synced_at: new Date().toISOString() };
  const url = SB_URL + "/rest/v1/jobs?ct_project_id=eq." + encodeURIComponent(ctId);
  const r = await fetch(url, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("eta patch " + r.status + ": " + (await r.text()));
}
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
    body.labor_ct       = breakdown;        // the full Labor Breakdown table
    body.labor_budget   = budTotal || 0;    // every type's budget, incl. engineering/PM/travel
    body.labor_actual   = actTotal || 0;
    body.labor_synced_at = new Date().toISOString();
  }
  if (!Object.keys(body).length) return;
  // labor_manual = someone corrected these by hand because CT was wrong. Leave them alone.
  const url = SB_URL + "/rest/v1/jobs?ct_project_id=eq." + encodeURIComponent(ctId) + "&labor_manual=eq.false";
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
      try { return { id: c.id, lm: c.lm, p: await ctGet(`/rest/v1/module/6/${c.id}`) }; }
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
      // When did this actually finish? CT's close date if it has one, otherwise the
      // last time the record changed. Never "today" — that was stamping every undated
      // job as finished this week and flooding the reports.
      var doneOn = null;
      if (isDone) {
        doneOn = onlyDate(det.expectedCloseDate) || (d.lm ? new Date(d.lm).toISOString().slice(0, 10) : null);
        if (!doneOn) { skipped++; continue; }          // undateable, can't report on it
        const cutoffDone = Date.now() - DONE_MONTHS * 30.4 * 86400000;
        if (new Date(doneOn).getTime() < cutoffDone) { skipped++; continue; }
      }
      // dates are no longer required — a job with none still belongs on the list, flagged
      const pre = onlyDate(det.installStartDate), on = onlyDate(det.onSiteDate), comp = onlyDate(det.expectedCloseDate);
      keepers.push({ id: d.id, det, p: d.p, pre, on, comp, phase, done: isDone, doneOn });
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
        completed_at: k.done ? k.doneOn : null,
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

    // 7) Labor Breakdown from CT.
    //    This is the expensive part — one API call per labor row, ~7 per job — so we
    //    only ask for what can actually have changed:
    //      • live jobs        -> every run, hours move daily
    //      • finished jobs    -> once, then never again (their hours are final)
    //      • labor_manual     -> never, someone corrected these by hand
    let laborTargets = keepers, backlog = 0;
    try {
      const q = SB_URL + "/rest/v1/jobs?select=ct_project_id,labor_synced_at,labor_manual";
      const r = await fetch(q, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
      if (r.ok) {
        const have = new Map((await r.json()).map((x) => [String(x.ct_project_id), x]));
        const live = [], toBackfill = [];
        for (const k of keepers) {
          const row = have.get(String(k.id));
          if (row && row.labor_manual) continue;                 // hand-corrected, leave alone
          if (!k.done) { live.push(k); continue; }                // still running
          if (!row || !row.labor_synced_at) toBackfill.push(k);   // finished, never pulled
        }
        backlog = Math.max(0, toBackfill.length - LABOR_BACKFILL);
        laborTargets = live.concat(toBackfill.slice(0, LABOR_BACKFILL));
      }
    } catch (e) { errors.push("labor plan: " + e.message); }

    await mapLimit(laborTargets, CONCURRENCY, async (k) => {
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

    // 8) estimated ship dates. The latest date across a job's line items is what
    //    gates the install, so that's what we keep. Skipped once gear is received.
    let etaSet = 0, etaCalls = 0, etaStale = 0;
    try {
      const q = SB_URL + "/rest/v1/jobs?select=ct_project_id,eta_synced_at,received_date";
      const r = await fetch(q, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
      const have = r.ok ? new Map((await r.json()).map((x) => [String(x.ct_project_id), x])) : new Map();
      const staleBefore = Date.now() - ETA_STALE_DAYS * 86400000;

      const due = keepers
        .filter((k) => {
          if (k.done) return false;                                  // finished work, no point
          const gearIn = k.det.gearReceived === 1 || k.det.gearReceived === true;
          if (gearIn) return false;                                  // it's here — ETA is moot
          const row = have.get(String(k.id));
          if (!row || !row.eta_synced_at) return true;               // never looked
          return Date.parse(row.eta_synced_at) < staleBefore;        // gone stale
        })
        .sort((a, b) => {
          const ra = have.get(String(a.id)), rb = have.get(String(b.id));
          const ta = ra && ra.eta_synced_at ? Date.parse(ra.eta_synced_at) : 0;
          const tb = rb && rb.eta_synced_at ? Date.parse(rb.eta_synced_at) : 0;
          return ta - tb;                                            // oldest first
        });
      etaStale = Math.max(0, due.length - ETA_JOBS_PER_RUN);

      await mapLimit(due.slice(0, ETA_JOBS_PER_RUN), CONCURRENCY, async (k) => {
        if (Date.now() - start > MAX_MS) { capped = true; return; }
        const assoc = (k.p.associations && k.p.associations.lineItems && k.p.associations.lineItems.results) || [];
        const items = assoc.slice(0, ETA_MAX_ITEMS);
        let latest = null, dated = 0;
        await mapLimit(items, CONCURRENCY, async (li) => {
          if (Date.now() - start > MAX_MS) { capped = true; return; }
          try {
            const d = await ctGet(`/rest/v1/module/167/${li.id}`);
            etaCalls++;
            // CT leaves estShipDate out of the payload when it's blank
            const raw = d && d.details && d.details.estShipDate;
            if (!raw) return;
            const iso = String(raw).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
            dated++;
            if (!latest || iso > latest) latest = iso;
          } catch (e) {}
        });
        try { await sbPatchEta(k.id, latest, dated, items.length); etaSet++; }
        catch (e) { errors.push("eta " + k.id + ": " + e.message); }
      });
    } catch (e) { errors.push("eta pass: " + e.message); }

    const note = `total ${total}, recent ${candidates}, opened ${opened}, kept ${kept}, hours ${hoursSet}, labor ${laborSet}, backlog ${backlog}, eta ${etaSet}/${etaCalls} calls, retired ${retired}, skipped ${skipped}${capped ? ", CAPPED" : ""}${errors.length ? ", errs " + errors.length : ""}`;
    await sbLog("cron", kept, errors.length ? "ok-with-errors" : "ok", note);
    res.status(200).json({ ok: true, total, recentCandidates: candidates, opened, kept, hoursFromCT: hoursSet, laborFromCT: laborSet, laborBacklog: backlog, etaJobs: etaSet, etaLineItemCalls: etaCalls, etaWaiting: etaStale, retired, skipped, capped, ms: Date.now() - start, sampleErrors: errors.slice(0, 5) });
  } catch (e) {
    await sbLog("cron", kept, "error", e.message);
    res.status(500).json({ error: e.message, opened, kept });
  }
};
