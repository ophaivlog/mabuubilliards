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

function matchesForEntry(entry) {
  return (entry.rounds || []).flatMap((round, roundIndex) =>
    (round.matches || [])
      .filter((match) => match?.playerA && match?.playerB && match.status !== "done")
      .map((match, matchIndex) => ({
        id: match.id || `${roundIndex}-${matchIndex}`,
        roundIndex: Number.isInteger(match.roundIndex) ? match.roundIndex : roundIndex,
        matchIndex: Number.isInteger(match.matchIndex) ? match.matchIndex : matchIndex,
        roundTitle: round.title || `Round ${roundIndex + 1}`,
        table: Number(match.table) || matchIndex + 1,
        playerA: match.playerA,
        playerB: match.playerB,
        scoreA: match.scoreA || "",
        scoreB: match.scoreB || "",
        status: match.status || "pending",
      })),
  );
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
    const entries = [
      {
        id: "current",
        isCurrent: true,
        tournament: data.tournament || {},
        players: data.players || [],
        rounds: data.rounds || [],
      },
      ...(Array.isArray(data.tournamentHistory) ? data.tournamentHistory : []).map((entry) => ({
        ...entry,
        isCurrent: false,
      })),
    ];

    return json(res, 200, {
      ok: true,
      tournaments: entries
        .map((entry) => ({
          id: entry.id || "current",
          name: entry.tournament?.name || "Giải đấu chưa đặt tên",
          date: entry.tournament?.date || "",
          isCurrent: !!entry.isCurrent,
          matches: matchesForEntry(entry),
        }))
        .filter((entry) => entry.matches.length),
    });
  } catch (error) {
    return json(res, error.statusCode || 500, { ok: false, message: error.message });
  }
};
