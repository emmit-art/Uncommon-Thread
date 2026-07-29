// ============================================================
// Uncommon Thread — Common Thread auto-sync (Vercel serverless cron)
// Repo path: api/sync.js   (upload it under an "api" folder)
// Runs on a schedule (see vercel.json). Reads active CT projects and
// upserts them into Supabase. Manual fields (lock_state, crew_size,
// color) are NOT sent, so they are never overwritten.
//
// Env vars (Vercel → Settings → Environment Variables), SERVER-SIDE:
//   CT_API_BASE                 e.g. https://ct.code3av.com
//   CT_API_TOKEN                the read-only Bearer token
//   SUPABASE_URL                https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   the secret service_role key
//   CRON_SECRET                 any random string (protects the endpoint)
// ============================================================

const CT_BASE = process.env.CT_API_BASE;
const CT_TOKEN = process.env.CT_API_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// CT phases we don't need on the schedule (finished / dead)
const SKIP_PHASES = new Set(["Complete","Canceled","Cancelled","Final Invoice","Under Warranty","Closeout Docs"]);
const MAX_MS = 50000;   // stop before Vercel's function timeout
const MAX_PAGES = 30;

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
  // auth: allow Vercel Cron (Authorization: Bearer CRON_SECRET) or manual ?key=
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    const key = (req.query && req.query.key) || "";
    if (auth !== "Bearer " + CRON_SECRET && key !== CRON_SECRET) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  if (!CT_BASE || !CT_TOKEN || !SB_URL || !SB_KEY) {
    res.status(500).json({ error: "missing env vars (need CT_API_BASE, CT_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)" });
    return;
  }

  const start = Date.now();
  let scanned = 0, updated = 0, skipped = 0, capped = false;
  const errors = [];
  const batch = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - start > MAX_MS) { capped = true; break; }
      const list = await ctGet(`/rest/v1/module/6?count=100&page=${page}`);
      const results = list.results || list.records || [];
      if (!results.length) break;

      for (const item of results) {
        if (Date.now() - start > MAX_MS) { capped = true; break; }
        scanned++;

        // fetch full detail (needed for dates, hours, POs)
        let p;
        try { p = await ctGet(`/rest/v1/module/6/${item.id}`); }
        catch (e) { errors.push("proj " + item.id + ": " + e.message); continue; }
        const det = p.details || {};

        const active = det.isActive === 1 || det.isActive === true;
        const phase = det.phase || "";
        if (!active || SKIP_PHASES.has(phase)) { skipped++; continue; }

        const pre = onlyDate(det.installStartDate);   // "Pre-Build Date"
        const on = onlyDate(det.onSiteDate);
        const comp = onlyDate(det.expectedCloseDate);
        if (!pre && !on && !comp) { skipped++; continue; }  // nothing to schedule

        // hours from Project Labor children (Install / Commissioning)
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

        // equipment ETA (☆): latest PO expected-delivery date, if set
        let eta = null;
        const pos = (p.associations && p.associations.purchaseOrders && p.associations.purchaseOrders.results) || [];
        for (const po of pos) {
          try {
            const pod = await ctGet(`/rest/v1/module/1004/${po.id}`);
            const ed = pod.details && (pod.details.expectedDeliveryDate || pod.details.expectedShippingDate);
            const dd = onlyDate(ed);
            if (dd && (!eta || dd > eta)) eta = dd;
          } catch (e) {}
        }

        const gearIn = det.gearReceived === 1 || det.gearReceived === true;
        const received = gearIn ? (comp || on || null) : null;
        const client = (det.clientCompanyID && det.clientCompanyID.title) || null;
        const pm = (det.projectManagerID && det.projectManagerID.title) || null;

        batch.push({
          ct_project_id: String(item.id),
          name: det.displayName || p.title || det.name || ("Project " + item.id),
          location: client,
          ct_phase: phase,
          pm_owner: pm,
          prebuild_date: pre,
          onsite_date: on,
          completion_date: comp,
          install_hours: Math.round(installHrs),
          commissioning_hours: Math.round(pncHrs),
          actual_hours: Math.round(actualHrs),
          eta_date: eta,
          received_date: received,
          is_active: true,
        });

        if (batch.length >= 50) { await sbUpsert(batch.splice(0)); updated += 50; }
      }
      if (capped) break;
      if (results.length < 100) break;   // last page
    }

    if (batch.length) { updated += batch.length; await sbUpsert(batch); }

    const note = `scanned ${scanned}, skipped ${skipped}, updated ${updated}${capped ? ", CAPPED(time)" : ""}${errors.length ? ", errs: " + errors.slice(0, 3).join(" | ") : ""}`;
    await sbLog("cron", updated, errors.length ? "ok-with-errors" : "ok", note);
    res.status(200).json({ ok: true, scanned, skipped, updated, capped, sampleErrors: errors.slice(0, 5) });
  } catch (e) {
    await sbLog("cron", updated, "error", e.message);
    res.status(500).json({ error: e.message, scanned, updated });
  }
};
