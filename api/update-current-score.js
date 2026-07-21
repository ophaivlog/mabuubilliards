const DEFAULT_TABLE = "tournament_state";
const DEFAULT_RECORD_ID = "main";

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function scoreOf(players) {
  return Array.isArray(players)
    ? players.reduce((total, player) => total + (Number(player?.score) || 0), 0)
    : 0;
}

function namesOf(players) {
  return Array.isArray(players)
    ? players.map((player) => normalizeName(player?.name)).filter(Boolean)
    : [];
}

function findLiveMatch(data) {
  const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const matches = Array.isArray(rounds[roundIndex]?.matches) ? rounds[roundIndex].matches : [];
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex];
      if (match?.status === "live" && match.playerA && match.playerB) {
        return { match, roundIndex, matchIndex };
      }
    }
  }
  return null;
}

function findSelectedMatch(data, payload) {
  const tournamentId = payload.tournamentId || "current";
  const roundIndex = Number(payload.roundIndex);
  const matchIndex = Number(payload.matchIndex);
  if (!Number.isInteger(roundIndex) || !Number.isInteger(matchIndex)) {
    return null;
  }

  const entry = tournamentId === "current"
    ? data
    : (Array.isArray(data?.tournamentHistory) ? data.tournamentHistory.find((item) => item.id === tournamentId) : null);
  const match = entry?.rounds?.[roundIndex]?.matches?.[matchIndex];

  if (!match?.playerA || !match?.playerB) {
    return null;
  }

  return { match, roundIndex, matchIndex, tournamentId };
}

function applyScoreToMatch(match, payload) {
  const leftScore = Number.isFinite(Number(payload.scoreA)) ? Number(payload.scoreA) : scoreOf(payload.left);
  const rightScore = Number.isFinite(Number(payload.scoreB)) ? Number(payload.scoreB) : scoreOf(payload.right);
  const leftNames = namesOf(payload.left);
  const rightNames = namesOf(payload.right);
  const playerA = normalizeName(match.playerA);
  const playerB = normalizeName(match.playerB);
  const leftHasA = leftNames.includes(playerA);
  const leftHasB = leftNames.includes(playerB);
  const rightHasA = rightNames.includes(playerA);
  const rightHasB = rightNames.includes(playerB);

  if ((leftHasA && rightHasB) || (!leftHasB && !rightHasA)) {
    match.scoreA = String(leftScore);
    match.scoreB = String(rightScore);
    return "left-right";
  }

  if (leftHasB && rightHasA) {
    match.scoreA = String(rightScore);
    match.scoreB = String(leftScore);
    return "right-left";
  }

  match.scoreA = String(leftScore);
  match.scoreB = String(rightScore);
  return "fallback";
}

function applyStatusToMatch(match, payload) {
  const status = String(payload.status || "").trim().toLowerCase();
  if (!["pending", "live", "done"].includes(status)) {
    return match.status || "pending";
  }

  match.status = status;
  if (status === "live") {
    match.winner = null;
    return status;
  }

  if (status === "done") {
    const scoreA = Number(match.scoreA);
    const scoreB = Number(match.scoreB);
    if (match.scoreA !== "" && match.scoreB !== "" && Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB) {
      match.winner = scoreA > scoreB ? match.playerA : match.playerB;
    }
  }

  return status;
}

async function supabaseRequest(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    const error = new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }

  const expectedToken = process.env.SCORE_PUSH_TOKEN;
  const receivedToken = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-score-token"];
  if (!expectedToken || receivedToken !== expectedToken) {
    return json(res, 401, { ok: false, message: "Unauthorized" });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const table = process.env.SUPABASE_TOURNAMENT_TABLE || DEFAULT_TABLE;
    const recordId = process.env.SUPABASE_TOURNAMENT_RECORD_ID || DEFAULT_RECORD_ID;
    const rows = await supabaseRequest(`${table}?id=eq.${encodeURIComponent(recordId)}&select=data`);
    const data = rows?.[0]?.data;
    const live = findSelectedMatch(data, payload) || findLiveMatch(data);

    if (!live) {
      return json(res, 409, { ok: false, message: "No selected or live match found" });
    }

    const mapping = applyScoreToMatch(live.match, payload);
    const status = applyStatusToMatch(live.match, payload);
    await supabaseRequest(`${table}?id=eq.${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        data,
        updated_at: new Date().toISOString(),
      }),
    });

    return json(res, 200, {
      ok: true,
      roundIndex: live.roundIndex,
      matchIndex: live.matchIndex,
      playerA: live.match.playerA,
      playerB: live.match.playerB,
      scoreA: live.match.scoreA,
      scoreB: live.match.scoreB,
      status,
      winner: live.match.winner || null,
      mapping,
    });
  } catch (error) {
    return json(res, error.statusCode || 500, { ok: false, message: error.message });
  }
};
