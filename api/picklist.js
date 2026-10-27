/* api/picklist.js — a job's equipment list, on demand, for the browser.
 *
 * Deliberately thin. It fetches, strips and hands over; it does NOT decide what
 * counts as a networked device. That judgement lives in the browser next to the
 * rules Nick corrects, so a correction takes effect the moment he clicks rather
 * than after a round trip, and so the whole classifier can be tested in the
 * jsdom harness like everything else in this app.
 *
 *   GET /api/picklist?jobs=26246,26244        Authorization: Bearer <supabase jwt>
 *
 * Auth is the caller's own Supabase session, not a shared secret — this is
 * called from the app by a signed-in person, and a secret in a URL would end up
 * in browser history. Verified against Supabase rather than taken on trust.
 *
 * MONEY IS STRIPPED before anything leaves here. Nick has no reason to see what
 * the gear cost, and a pick list is not the place for it to leak.
 *
 * Env: CT_API_BASE, CT_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      SUPABASE_ANON_KEY
 */
const CT_BASE = String(process.env.CT_API_BASE || "").trim().replace(/\/+$/,"");
// trimmed: a token pasted with a trailing newline is indistinguishable from
// a wrong one at the other end — CT just answers 401 and says nothing useful
const CT_TOKEN = String(process.env.CT_API_TOKEN || "").trim();
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON = process.env.SUPABASE_ANON_KEY || SB_KEY;

const MAX_JOBS = 12;         // he selects a handful; a dozen is generous
const MAX_LINES = 150;
const CONCURRENCY = 10;
const MAX_MS = 50000;

async function ctGet(path) {
  const r = await fetch(CT_BASE + path, {
    headers: { Authorization: "Bearer " + CT_TOKEN, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("CT " + path + " -> " + r.status);
  return r.json();
}
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) || 0 }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
  }));
  return out;
}
async function whoIsAsking(req) {
  const tok = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!tok) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + tok } });
    if (!r.ok) return null;
    const u = await r.json();
    return ((u && u.email) || "").toLowerCase() || null;
  } catch (e) { return null; }
}

/* CT writes displayName as "<job> - <part> - <room>". The part code is what we
   want and it is the only place some lines carry a model at all — 26242's Biamp
   Parlé has no description field whatsoever. Peel the known job number off the
   front and the known room off the back rather than splitting on " - ", because
   a room called "Room 3 - West" would otherwise eat half the part number. */
function partCode(displayName, jobNum, room) {
  let s = String(displayName || "").trim();
  if (jobNum && s.startsWith(jobNum)) s = s.slice(jobNum.length).replace(/^\s*-\s*/, "");
  if (room) {
    const tail = " - " + room;
    if (s.toLowerCase().endsWith(tail.toLowerCase())) s = s.slice(0, -tail.length);
  }
  return s.trim();
}

module.exports = async (req, res) => {
  if (!CT_BASE || !CT_TOKEN || !SB_URL || !SB_KEY) {
    res.status(500).json({ error: "server is missing its Common Thread or Supabase settings" });
    return;
  }
  const who = await whoIsAsking(req);
  if (!who) { res.status(401).json({ error: "sign in first" }); return; }

  const q = req.query || {};
  const wanted = String(q.jobs || q.job || "").split(/[,\s]+/).filter(Boolean).slice(0, MAX_JOBS);
  if (!wanted.length) { res.status(400).json({ error: "no jobs asked for" }); return; }

  const start = Date.now();
  try {
    const sb = await fetch(SB_URL + "/rest/v1/jobs?select=project_number,ct_project_id,name,location" +
      "&project_number=in.(" + encodeURIComponent(wanted.join(",")) + ")",
      { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
    const rows = sb.ok ? await sb.json() : [];

    const jobs = await mapLimit(rows, 3, async (row) => {
      const num = String(row.project_number);
      try {
        // the association endpoint, with a count. The project record embeds only
        // about five line items and does not say so — reading those was how this
        // started out seeing a third of every BOM.
        const r = await ctGet(`/rest/v1/module/6/${row.ct_project_id}/association/obligationitem?count=300`);
        const list = (Array.isArray(r) ? r : (r && (r.results || r.data)) || []).slice(0, MAX_LINES);
        const lines = await mapLimit(list, CONCURRENCY, async (li) => {
          if (Date.now() - start > MAX_MS) return null;
          try {
            const d = (await ctGet(`/rest/v1/module/167/${li.id}`)).details || {};
            const room = (d.projectRoomID && (d.projectRoomID.title || d.projectRoomID)) || "";
            const make = (d.manufacturerID && (d.manufacturerID.title || d.manufacturerID)) || "";
            return {
              id: d.obligationItemID || li.id,
              part: partCode(d.displayName, num, room),
              make: String(make),
              desc: String(d.description || ""),
              qty: Number(d.qty) || 1,
              kind: String(d.type || ""),            // Equipment | Labor | Misc
              room: String(room),
              serialized: d.isSerialized === 1,
            };
          } catch (e) { return null; }
        });
        const got = lines.filter(Boolean);
        return {
          job: num, name: row.name, loc: row.location || "",
          total: list.length, read: got.length,
          truncated: list.length < (Array.isArray(r) ? r.length : 0) || undefined,
          lines: got,
        };
      } catch (e) {
        return { job: num, name: row.name, error: String(e.message || e), lines: [] };
      }
    });

    const asked = new Set(wanted);
    rows.forEach((r) => asked.delete(String(r.project_number)));
    res.status(200).json({
      ok: true, ms: Date.now() - start,
      notFound: asked.size ? [...asked] : undefined,
      jobs,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.partCode = partCode;
