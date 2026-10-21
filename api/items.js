/* api/items.js — LOOK at a job's equipment list. Read-only, writes nothing.
 *
 * The pick list stands or falls on one question: does Common Thread's line-item
 * text actually name the hardware ("Netgear M4250-10G2F-PoE+ switch") or does it
 * say "AV Equipment, see attached quote"? Rules can sort the first. Nothing can
 * sort the second. PatchBay has never read the BOM, so this exists to find out
 * before anything gets built on top of an assumption.
 *
 *   /api/items?key=CRON_SECRET&job=26246
 *   /api/items?key=CRON_SECRET&job=26246,26244,26242        (up to 6)
 *
 * MONEY IS STRIPPED. Unit price, cost, totals, tax, labor and shipping amounts
 * are removed before anything is returned, because this output goes into a
 * browser URL bar, Vercel's request log, and probably a chat window. What comes
 * back is descriptions and quantities — the things a pick list needs.
 *
 * Env: CT_API_BASE, CT_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
 */
const CT_BASE = process.env.CT_API_BASE;
const CT_TOKEN = process.env.CT_API_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_JOBS = 6;
const MAX_LINES = 80;          // enough to see the shape; a big job won't time us out
const CONCURRENCY = 8;
const MAX_MS = 50000;

/* every key that could carry a number someone would rather not see in a log */
const MONEY = /price|cost|total|tax|amount|margin|profit|discount|msrp|revenue|paid|billed|invoic/i;

async function ctGet(path) {
  const r = await fetch(CT_BASE + path, {
    headers: { Authorization: "Bearer " + CT_TOKEN, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("CT " + path + " -> " + r.status);
  return r.json();
}
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
  }));
  return out;
}
/* keep only what a pick list could use, and only if it isn't empty */
function scrub(det) {
  const out = {};
  for (const k of Object.keys(det || {})) {
    if (MONEY.test(k)) continue;
    const v = det[k];
    if (v == null || v === "" || v === 0) continue;
    if (typeof v === "object") {                  // CT nests lookups as {id,title}
      if (v.title) out[k] = String(v.title);
      continue;
    }
    out[k] = typeof v === "string" ? v.slice(0, 160) : v;
  }
  return out;
}

module.exports = async (req, res) => {
  if (!CT_BASE || !CT_TOKEN || !SB_URL || !SB_KEY) {
    res.status(500).json({ error: "CT_API_BASE, CT_API_TOKEN, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set" });
    return;
  }
  const q = req.query || {};
  if (CRON_SECRET) {
    const want = String(CRON_SECRET).trim();
    const got = String(q.key || "").trim();
    const hdr = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    if (got !== want && hdr !== want) { res.status(401).json({ error: "unauthorized" }); return; }
  }

  const wanted = String(q.job || "").split(/[,\s]+/).filter(Boolean).slice(0, MAX_JOBS);
  if (!wanted.length) {
    res.status(400).json({ error: "which job?", example: "/api/items?key=…&job=26246,26244" });
    return;
  }

  const start = Date.now();
  try {
    // project numbers -> CT ids, out of our own table rather than scanning 548 projects
    const sb = await fetch(SB_URL + "/rest/v1/jobs?select=project_number,ct_project_id,name" +
      "&project_number=in.(" + encodeURIComponent(wanted.join(",")) + ")",
      { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
    const rows = sb.ok ? await sb.json() : [];
    const missing = wanted.filter((w) => !rows.some((r) => String(r.project_number) === w));

    const jobs = await mapLimit(rows, 2, async (row) => {
      try {
        const p = await ctGet(`/rest/v1/module/6/${row.ct_project_id}`);
        const assoc = (p.associations && p.associations.lineItems && p.associations.lineItems.results) || [];
        const ids = assoc.slice(0, MAX_LINES);
        const lines = await mapLimit(ids, CONCURRENCY, async (li) => {
          if (Date.now() - start > MAX_MS) return null;
          try { return scrub((await ctGet(`/rest/v1/module/167/${li.id}`)).details); }
          catch (e) { return { _error: String(e.message || e) }; }
        });
        const got = lines.filter(Boolean);
        // which fields CT actually populates, and how often — the real answer to
        // "is there enough text here", in one line per job
        const fill = {};
        got.forEach((l) => Object.keys(l).forEach((k) => { fill[k] = (fill[k] || 0) + 1; }));
        return {
          job: row.project_number, name: row.name, ctId: row.ct_project_id,
          lineItemsTotal: assoc.length, read: got.length,
          fieldsPopulated: Object.fromEntries(
            Object.entries(fill).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v + "/" + got.length])),
          lines: got,
        };
      } catch (e) { return { job: row.project_number, error: String(e.message || e) }; }
    });

    res.status(200).json({
      ok: true,
      note: "read-only; all price, cost, tax and margin fields removed before sending",
      missingFromPatchBay: missing.length ? missing : undefined,
      ms: Date.now() - start,
      jobs,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
