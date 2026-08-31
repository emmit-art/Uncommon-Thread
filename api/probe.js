// PatchBay3 — TEMPORARY diagnostic. Deploy as api/probe.js, use it, then DELETE it.
//
// Finds where Common Thread keeps "Est Ship Date" by dumping the raw shape of a
// project and its line items. Read-only: it never writes anything, to CT or to us.
//
// Usage — pick a project you KNOW has ship dates filled in:
//   /api/probe?key=<CRON_SECRET>&project=26165
//   /api/probe?key=<CRON_SECRET>&id=3356          (CT internal ItemID, from the URL)
//
// It reports every field name it finds, and flags anything that smells like a date
// or a ship field, so we can spot the right one even if it's named oddly.

const CT_BASE = process.env.CT_API_BASE;
const CT_TOKEN = process.env.CT_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

async function ctGet(path) {
  const r = await fetch(CT_BASE + path, {
    headers: { Authorization: "Bearer " + CT_TOKEN, Accept: "application/json" },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 400); }
  return { ok: r.ok, status: r.status, body };
}

// walk an object and collect "path -> value" for anything scalar
function flatten(obj, prefix, out, depth) {
  if (!obj || typeof obj !== "object" || depth > 3) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? prefix + "." + k : k;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      out[path] = v;
    } else if (Array.isArray(v)) {
      out[path] = "[array of " + v.length + "]";
      if (v.length && typeof v[0] === "object") flatten(v[0], path + "[0]", out, depth + 1);
    } else {
      flatten(v, path, out, depth + 1);
    }
  }
  return out;
}

const looksLikeDate = (v) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v);
// test the LEAF name only — "details.foo" contains "eta", which would match everything
const looksLikeShip = (k) => /ship|eta|deliver|arriv|expect|due|receiv|promis|lead/i
  .test(String(k).split(".").pop().replace(/\[\d+\]$/, ""));

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const key = (req.query && req.query.key) || "";
    const auth = req.headers["authorization"] || "";
    if (key !== CRON_SECRET && auth !== "Bearer " + CRON_SECRET) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const num = (req.query && req.query.project) || "";
  let id = (req.query && req.query.id) || "";
  const out = { lookedFor: num || id, notes: [] };

  try {
    // 1) find the project by its number if we weren't given an internal id
    if (!id && num) {
      for (let page = 1; page <= 12 && !id; page++) {
        const list = await ctGet(`/rest/v1/module/6?count=100&page=${page}`);
        if (!list.ok) { out.notes.push("project list " + list.status); break; }
        const rows = (list.body && (list.body.results || list.body.records)) || [];
        if (!rows.length) break;
        for (const r of rows) {
          const d = await ctGet(`/rest/v1/module/6/${r.id}`);
          const det = (d.body && d.body.details) || {};
          if (String(det.customID || "") === String(num) ||
              String(det.displayName || "").startsWith(String(num))) { id = r.id; break; }
        }
      }
    }
    if (!id) { res.status(404).json({ error: "project not found", ...out }); return; }
    out.projectId = id;

    // 2) the project record — what associations does it even have?
    const proj = await ctGet(`/rest/v1/module/6/${id}`);
    if (!proj.ok) { res.status(200).json({ ...out, projectFetch: proj.status }); return; }
    const p = proj.body || {};
    out.projectName = (p.details && (p.details.displayName || p.details.customID)) || null;
    out.associations = Object.keys(p.associations || {}).map((k) => {
      const a = p.associations[k];
      return k + " (" + ((a && a.results && a.results.length) || 0) + ")";
    });

    // 3) line items — the grid where Est Ship Date is shown in the UI
    const liKeys = Object.keys(p.associations || {}).filter((k) => /line|item|product|equip/i.test(k));
    out.lineItemAssociations = liKeys;
    out.lineItems = [];
    for (const key of liKeys) {
      const rows = (p.associations[key].results || []).slice(0, 3);   // 3 is enough to see the shape
      for (const li of rows) {
        const d = await ctGet(`/rest/v1/module/167/${li.id}`);
        if (!d.ok) { out.lineItems.push({ assoc: key, id: li.id, status: d.status }); continue; }
        const flat = flatten(d.body, "", {}, 0);
        const dates = {}, shipish = {};
        for (const [k, v] of Object.entries(flat)) {
          if (looksLikeDate(v)) dates[k] = v;
          if (looksLikeShip(k)) shipish[k] = v;
        }
        out.lineItems.push({
          assoc: key, id: li.id, title: li.title || null,
          everyFieldName: Object.keys(flat),          // full list, so nothing is missed
          anythingDateShaped: dates,                  // values that look like dates
          anythingShipNamed: shipish,                 // field names mentioning ship/eta/deliver
        });
      }
    }

    // 3b) FOUND: estShipDate lives on the line item, but CT omits the field when empty.
    //     Now the question is cost — can we pull a whole project's line items in ONE
    //     call instead of one call per item? Try the filter syntaxes CT might support.
    const projId = id;
    const attempts = [
      `/rest/v1/module/167?count=200&projectID=${projId}`,
      `/rest/v1/module/167?count=200&filter=projectID eq ${projId}`,
      `/rest/v1/module/167?count=200&where=projectID=${projId}`,
      `/rest/v1/module/167?count=200&search=${projId}`,
      `/rest/v1/module/167/?count=200&projectId=${projId}`,
    ];
    out.bulkLineItemTests = [];
    for (const a of attempts) {
      const r = await ctGet(a);
      const rows = (r.body && (r.body.results || r.body.records)) || [];
      const first = rows[0] || null;
      out.bulkLineItemTests.push({
        url: a, status: r.status, rowsReturned: rows.length,
        total: (r.body && r.body.total) || null,
        // did it actually filter to THIS project, or just return everything?
        firstRowTitle: first && first.title ? String(first.title).slice(0, 60) : null,
        firstRowHasDetails: !!(first && first.details),
        firstRowEstShip: first && first.details ? (first.details.estShipDate || null) : null,
        firstRowProject: first && first.details && first.details.projectID
          ? (first.details.projectID.id || first.details.projectID) : null,
      });
    }

    // 4) are custom fields readable now? (this is what was blocked before)
    const ce = await ctGet(`/rest/v1/module/159?count=100`);
    out.customElements = ce.ok
      ? (ce.body.results || []).map((x) => ({ id: x.id, title: x.title }))
      : { blocked: ce.status, message: ce.body };

    // 5) and the values, if we can see them
    const cev = await ctGet(`/rest/v1/module/160?count=20`);
    out.customElementValues = cev.ok
      ? (cev.body.results || []).slice(0, 5)
      : { blocked: cev.status, message: cev.body };

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message), ...out });
  }
};
