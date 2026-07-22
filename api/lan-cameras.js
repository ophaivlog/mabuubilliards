const DEFAULT_TABLE = "tournament_state";
const DEFAULT_RECORD_ID = "main";

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function supabaseRequest(path) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    const error = new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(body?.message || text || `Supabase HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return body;
}

function normalizeCamera(item) {
  const table = Number(item?.table);
  const address = String(item?.address || "").trim();
  const verifyCode = String(item?.verifyCode || "").trim();
  if (!Number.isInteger(table) || table <= 0 || !address) return null;
  return {
    table,
    address,
    verifyCode,
    label: `Ban ${String(table).padStart(2, "0")} - ${address}`,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }

  const expectedToken = process.env.SCORE_PUSH_TOKEN;
  const receivedToken = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-score-token"];
  if (!expectedToken || receivedToken !== expectedToken) {
    return json(res, 401, { ok: false, message: "Unauthorized" });
  }

  try {
    const table = process.env.SUPABASE_TOURNAMENT_TABLE || DEFAULT_TABLE;
    const recordId = process.env.SUPABASE_TOURNAMENT_RECORD_ID || DEFAULT_RECORD_ID;
    const rows = await supabaseRequest(`${table}?id=eq.${encodeURIComponent(recordId)}&select=data`);
    const data = rows?.[0]?.data || {};
    const cameras = Array.isArray(data.lanCameras)
      ? data.lanCameras.map(normalizeCamera).filter(Boolean).sort((a, b) => a.table - b.table)
      : [];

    return json(res, 200, { ok: true, cameras });
  } catch (error) {
    return json(res, error.statusCode || 500, { ok: false, message: error.message });
  }
};
