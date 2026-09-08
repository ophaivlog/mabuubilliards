const STORAGE_KEY = "maBuuTournament.v1";
const cardWidth = 320;
const cardHeight = 128;
const rowHeight = 148;
const gapX = 76;
const topOffset = 70;
const tableCount = 14;
let ezvizPlayer = null;
let tournamentLivePlayer = null;
let activeTournamentLiveMatch = null;
const isAdmin = document.body?.dataset.mode === "admin";
let supabaseClient = null;
let cloudSaveTimer = null;
let lastLocalEditAt = 0;
let adminUnlockPromise = null;
let unlockedAdminUserId = null;
const LOCAL_EDIT_SYNC_GUARD_MS = 30000;

const defaultPlayers = [
  "Nguyễn Minh",
  "Trần Hoàng",
  "Lê Quốc",
  "Phạm Anh",
  "Đặng Khoa",
  "Võ Tùng",
  "Bùi Nam",
  "Hoàng Long",
  "Đỗ Hải",
  "Huỳnh Phúc",
  "Mai Sơn",
  "Cao Việt",
  "Vũ Duy",
  "Trịnh Khải",
  "Hồ Nhật",
  "Đinh Lâm",
];

const state = loadState();
let selectedTournamentId = "current";
let selectedTournamentDetailTab = "info";
let selectedDetailRoundIndex = 0;
let selectedBracketRoundIndex = 0;
let bracketRenderRoundOffset = 0;
let selectedCameraView = "lan";
let pendingAppPin = null;
let bracketFitMode = false;
let bracketManualScale = 1;
let bracketResizeObserver = null;

function createDefaultState() {
  return {
    tournament: {
      name: "Ma Buu Billiards Tournament",
      date: new Date().toISOString().slice(0, 10),
      format: "single",
      rank: "Mở rộng",
      organizer: "Ma Buu Billiards",
      location: "Ma Buu Billiards Club",
      description: "",
    },
    players: [],
    playerStats: [],
    rankingIgnoredResults: [],
    rankingExcludedPlayers: [],
    registrationRequests: [],
    lanCameras: [],
    contact: {
      name: "Ma Buu Billiards",
      address: "Thông tin quán trên Google Maps",
      phone: "",
      email: "",
      mapsUrl: "https://maps.app.goo.gl/BNGmfofiftazmygW6",
      note: "",
    },
    appPin: "123456",
    adBanner: { enabled: false, name: "", url: "" },
    tournamentHistory: [],
    rounds: [],
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return parsed?.tournament ? normalizeStateShape(parsed) : createDefaultState();
  } catch (error) {
    return createDefaultState();
  }
}

function cacheState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function normalizeStateShape(target) {
  target.tournament = {
    ...createDefaultState().tournament,
    ...(target.tournament || {}),
  };

  if (!Array.isArray(target.players)) {
    target.players = [];
  }

  if (!Array.isArray(target.playerStats)) {
    target.playerStats = [];
  }
  if (!Array.isArray(target.rankingIgnoredResults)) {
    target.rankingIgnoredResults = [];
  }
  if (!Array.isArray(target.rankingExcludedPlayers)) {
    target.rankingExcludedPlayers = [];
  }

  if (!Array.isArray(target.registrationRequests)) {
    target.registrationRequests = [];
  }

  if (!Array.isArray(target.lanCameras)) {
    target.lanCameras = [];
  }
  target.contact = {
    ...createDefaultState().contact,
    ...(target.contact || {}),
  };
  target.lanCameras = target.lanCameras.map(normalizeLanCamera).filter(Boolean).sort((a, b) => a.table - b.table);
  target.appPin = normalizeAppPin(target.appPin) || "123456";
  target.adBanner = normalizeAdBanner(target.adBanner);

  if (!Array.isArray(target.tournamentHistory)) {
    target.tournamentHistory = [];
  }

  if (!Array.isArray(target.rounds)) {
    target.rounds = [];
  }

  const firstDiagramLoserRound = target.rounds.findIndex((round) => round.bracketGroup === "diagram-loser");
  const firstDiagramWinnerRound = target.rounds.findIndex((round) => round.bracketGroup === "diagram-winner");
  if (firstDiagramWinnerRound >= 0) {
    target.rounds.forEach((round, roundIndex) => {
      if (round.bracketGroup !== "diagram-winner") return;
      (round.matches || []).forEach((match, matchIndex) => {
        const previousRoundWasOdd = roundIndex > firstDiagramWinnerRound && target.rounds[roundIndex - 1]?.bracketGroup === "diagram-winner" && target.rounds[roundIndex - 1].matches.length % 2 === 1;
        match.allowSingleAdvance = roundIndex === firstDiagramWinnerRound || (previousRoundWasOdd && matchIndex === round.matches.length - 1);
        const hasOnlyOnePlayer = Boolean(match.playerA) !== Boolean(match.playerB);
        const wasPrematureBye = roundIndex > firstDiagramWinnerRound && !match.allowSingleAdvance && hasOnlyOnePlayer && match.status === "done" && (match.scoreA === "W" || match.scoreB === "W");
        if (wasPrematureBye) {
          match.scoreA = "";
          match.scoreB = "";
          match.winner = null;
          match.status = "waiting";
        }
      });
    });
  }
  if (firstDiagramLoserRound >= 0) {
    target.rounds.forEach((round, roundIndex) => {
      if (round.bracketGroup !== "diagram-loser") return;
      (round.matches || []).forEach((match, matchIndex) => {
        const previousRoundWasOdd = roundIndex > firstDiagramLoserRound && target.rounds[roundIndex - 1]?.bracketGroup === "diagram-loser" && target.rounds[roundIndex - 1].matches.length % 2 === 1;
        match.allowSingleAdvance = roundIndex === firstDiagramLoserRound || (previousRoundWasOdd && matchIndex === round.matches.length - 1);
        const hasOnlyOnePlayer = Boolean(match.playerA) !== Boolean(match.playerB);
        const wasPrematureBye = roundIndex > firstDiagramLoserRound && !match.allowSingleAdvance && hasOnlyOnePlayer && match.status === "done" && (match.scoreA === "W" || match.scoreB === "W");
        if (wasPrematureBye) {
          match.scoreA = "";
          match.scoreB = "";
          match.winner = null;
          match.status = "waiting";
        }
      });
    });
  }

  const hasLegacyDoubleBracket = target.tournament?.format === "double" && target.rounds.length && !target.rounds.some((round) =>
    round.bracketGroup?.startsWith("diagram-"),
  );
  const hasPlayedLegacyMatch = target.rounds.some((round) => (round.matches || []).some((match) =>
    match.status === "done" && match.playerA && match.playerB && match.scoreA !== "W" && match.scoreB !== "W",
  ));
  const hasOutdated24Diagram = target.tournament?.format === "double" && target.players.length === 24 && target.rounds[0]?.bracketGroup === "diagram-winner" && target.rounds[0]?.matches?.length !== 12;
  if (hasOutdated24Diagram && !hasPlayedLegacyMatch) {
    target.rounds = buildDiagramBracket(target.players.map((player) => player.name));
  }
  if (hasLegacyDoubleBracket && !hasPlayedLegacyMatch && [16, 24, 32].includes(target.players.length)) {
    const slots = target.players.slice(0, 32).map((player) => player.name);
    target.rounds = buildDiagramBracket(slots);
  }

  return target;
}

function saveState() {
  if (!isAdmin) {
    return;
  }

  cacheState();
  queueCloudSave();
}

function getSupabaseSettings() {
  return window.MABUU_SUPABASE || {};
}

function getSupabaseClient() {
  const settings = getSupabaseSettings();

  if (!settings.url || !settings.anonKey || !window.supabase?.createClient) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(settings.url, settings.anonKey);
  }

  return supabaseClient;
}

function getRegistrationRequestsTable() {
  return getSupabaseSettings().requestsTable || "tournament_registration_requests";
}

function setCloudStatus(message, type = "muted") {
  const status = document.querySelector("#cloudStatus");

  if (!status) {
    return;
  }

  // Keep successful cloud synchronization silent; only loading states and
  // actionable errors need to be shown to the user.
  status.hidden = type === "ok";

  status.textContent = message;
  status.dataset.type = type;
}

function setAdminNotice(message, type = "muted") {
  if (!isAdmin) {
    return;
  }

  setCloudStatus(message, type);
}

function setRegistrationStatus(message, type = "muted") {
  const status = document.querySelector("#registrationStatus");

  if (!status) {
    return;
  }

  status.textContent = message;
  status.dataset.type = type;
}

function setLoginStatus(message, type = "muted") {
  const status = document.querySelector("#adminLoginStatus");

  if (!status) {
    return;
  }

  status.textContent = message;
  status.dataset.type = type;
}

function isTypingInEditableField() {
  const active = document.activeElement;
  const hasRecentLocalEdit = Date.now() - lastLocalEditAt < LOCAL_EDIT_SYNC_GUARD_MS;
  if (!active || active === document.body || active.closest("#adminLogin")) {
    return hasRecentLocalEdit;
  }

  return hasRecentLocalEdit || Boolean(
    active.matches?.("input:not([type='button']):not([type='submit']):not([type='reset']), textarea, select") ||
      active.isContentEditable,
  );
}

function markLocalEdit(event) {
  const target = event.target;
  if (!target || target.closest?.("#adminLogin")) {
    return;
  }

  if (
    target.matches?.("input:not([type='button']):not([type='submit']):not([type='reset']), textarea, select") ||
    target.isContentEditable
  ) {
    lastLocalEditAt = Date.now();
  }
}

function applyRemoteState(remoteState) {
  if (!remoteState?.tournament) {
    return false;
  }

  state.tournament = remoteState.tournament || createDefaultState().tournament;
  state.players = Array.isArray(remoteState.players) ? remoteState.players : [];
  state.playerStats = Array.isArray(remoteState.playerStats) ? remoteState.playerStats : state.playerStats || [];
  state.rankingIgnoredResults = Array.isArray(remoteState.rankingIgnoredResults) ? remoteState.rankingIgnoredResults : state.rankingIgnoredResults || [];
  state.rankingExcludedPlayers = Array.isArray(remoteState.rankingExcludedPlayers) ? remoteState.rankingExcludedPlayers : state.rankingExcludedPlayers || [];
  state.lanCameras = Array.isArray(remoteState.lanCameras) ? remoteState.lanCameras : [];
  state.contact = {
    ...createDefaultState().contact,
    ...(remoteState.contact || {}),
  };
  state.appPin = normalizeAppPin(remoteState.appPin) || state.appPin || "123456";
  state.adBanner = normalizeAdBanner(remoteState.adBanner || state.adBanner);
  state.tournamentHistory = Array.isArray(remoteState.tournamentHistory) ? remoteState.tournamentHistory : [];
  state.rounds = Array.isArray(remoteState.rounds) ? remoteState.rounds : [];
  normalizeStateShape(state);
  cacheState();
  renderAll();
  return true;
}

async function loadCloudState() {
  const client = getSupabaseClient();
  const settings = getSupabaseSettings();

  if (!client) {
    setCloudStatus("Chưa cấu hình Supabase, đang dùng dữ liệu trên máy này.");
    return;
  }

  setCloudStatus("Đang tải dữ liệu từ Supabase...");

  try {
    const { data, error } = await client
      .from(settings.table || "tournament_state")
      .select("data")
      .eq("id", settings.recordId || "main")
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (isTypingInEditableField()) {
      setCloudStatus("Đang nhập, tạm hoãn đồng bộ Supabase để không mất nội dung.", "muted");
      return;
    }

    if (applyRemoteState(data?.data)) {
      setCloudStatus("Đã đồng bộ dữ liệu từ Supabase.", "ok");
      return;
    }

    setCloudStatus(isAdmin ? "Supabase chưa có dữ liệu, hãy tạo giải rồi lưu." : "Chưa có dữ liệu giải trên Supabase.");
  } catch (error) {
    setCloudStatus(`Không tải được Supabase: ${error.message}`, "error");
  }
}

async function saveCloudState() {
  const client = getSupabaseClient();
  const settings = getSupabaseSettings();

  if (!client) {
    setCloudStatus("Chưa cấu hình Supabase, dữ liệu mới chỉ lưu trên máy này.");
    return;
  }

  try {
    setCloudStatus("Đang lưu lên Supabase...");
    const { error } = await client.from(settings.table || "tournament_state").upsert({
      id: settings.recordId || "main",
      data: {
        tournament: state.tournament,
        players: state.players,
        playerStats: state.playerStats,
        rankingIgnoredResults: state.rankingIgnoredResults,
        rankingExcludedPlayers: state.rankingExcludedPlayers,
        lanCameras: state.lanCameras,
        contact: state.contact,
        appPin: state.appPin,
        adBanner: state.adBanner,
        tournamentHistory: state.tournamentHistory,
        rounds: state.rounds,
      },
      updated_at: new Date().toISOString(),
    });

    if (error) {
      throw error;
    }

    setCloudStatus("Đã lưu lên Supabase.", "ok");
  } catch (error) {
    setCloudStatus(`Không lưu được Supabase: ${error.message}`, "error");
  }
}

async function loadRegistrationRequests() {
  if (!isAdmin) {
    return;
  }

  const client = getSupabaseClient();

  if (!client) {
    state.registrationRequests = [];
    return;
  }

  try {
    const { data, error } = await client
      .from(getRegistrationRequestsTable())
      .select("id,name,phone,note,status,created_at,reviewed_at")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    state.registrationRequests = (data || []).map((request) => ({
      id: request.id,
      name: request.name,
      phone: request.phone,
      note: request.note,
      status: request.status || "pending",
      createdAt: request.created_at,
      reviewedAt: request.reviewed_at,
    }));
  } catch (error) {
    state.registrationRequests = [];
    setAdminNotice(`Không tải được yêu cầu đăng ký: ${error.message}`, "error");
  }
}

async function updateRegistrationRequestStatus(requestId, status) {
  const client = getSupabaseClient();

  if (!client) {
    throw new Error("Chưa cấu hình Supabase.");
  }

  const { error } = await client
    .from(getRegistrationRequestsTable())
    .update({
      status,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  if (error) {
    throw error;
  }
}

function queueCloudSave() {
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(saveCloudState, 450);
}

function startCloudAutoRefresh() {
  if (isAdmin || !getSupabaseClient()) {
    return;
  }

  setInterval(loadCloudState, 10000);
}

async function unlockAdmin(session = null) {
  const userId = session?.user?.id || null;

  if (document.body.dataset.auth === "unlocked" && userId && unlockedAdminUserId === userId) {
    return;
  }

  if (adminUnlockPromise) {
    return adminUnlockPromise;
  }

  unlockedAdminUserId = userId;
  adminUnlockPromise = (async () => {
    document.body.dataset.auth = "unlocked";
    setLoginStatus("Đã đăng nhập.", "ok");
    renderAll();
    await loadCloudState();
    await loadRegistrationRequests();
    if (!isTypingInEditableField()) {
      renderAll();
    }
  })();

  try {
    await adminUnlockPromise;
  } finally {
    adminUnlockPromise = null;
  }
}

function lockAdmin() {
  unlockedAdminUserId = null;
  document.body.dataset.auth = "locked";
  setLoginStatus("Dùng tài khoản đã tạo trong Supabase Authentication.");
}

function bindAdminAuth() {
  if (!isAdmin) {
    return;
  }

  const client = getSupabaseClient();
  const form = document.querySelector("#adminLoginForm");
  const emailInput = document.querySelector("#adminEmail");
  const passwordInput = document.querySelector("#adminPassword");
  const logoutButton = document.querySelector("#adminLogout");

  if (!client) {
    lockAdmin();
    setLoginStatus("Chưa cấu hình Supabase nên chưa thể đăng nhập admin.", "error");
    return;
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoginStatus("Đang đăng nhập...");

    const { data, error } = await client.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });

    if (error) {
      setLoginStatus(`Không đăng nhập được: ${error.message}`, "error");
      return;
    }

    passwordInput.value = "";
    await unlockAdmin(data?.session || null);
  });

  logoutButton?.addEventListener("click", async () => {
    await client.auth.signOut();
    lockAdmin();
  });
}

async function initAdminAuth() {
  if (!isAdmin) {
    return false;
  }

  bindAdminAuth();
  const client = getSupabaseClient();

  if (!client) {
    return true;
  }

  const { data, error } = await client.auth.getSession();
  if (error) {
    lockAdmin();
    setLoginStatus(`Không đọc được phiên đăng nhập: ${error.message}`, "error");
    return true;
  }

  if (data?.session) {
    await unlockAdmin(data.session);
  } else {
    lockAdmin();
  }

  client.auth.onAuthStateChange((event, session) => {
    // Supabase can deadlock when another Supabase request is awaited directly
    // inside this callback. Defer all UI/data work until the callback returns.
    setTimeout(() => {
      if (!session || event === "SIGNED_OUT") {
        lockAdmin();
        return;
      }

      // TOKEN_REFRESHED keeps the current UI/session alive; it must not trigger
      // another full data load. SIGNED_IN and INITIAL_SESSION are sufficient.
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        unlockAdmin(session).catch((authError) => {
          setLoginStatus(`Không mở được trang admin: ${authError.message}`, "error");
        });
      }
    }, 0);
  });

  return true;
}

function getJson(url) {
  if (typeof fetch === "function") {
    return fetch(url).then((response) => response.json());
  }

  if (typeof XMLHttpRequest === "function") {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", url);
      request.onload = () => {
        try {
          resolve(JSON.parse(request.responseText));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(new Error("Network request failed"));
      request.send();
    });
  }

  return new Promise((resolve, reject) => {
    const callbackName = `ezvizJsonp_${Date.now()}_${Math.round(Math.random() * 100000)}`;
    const script = document.createElement("script");
    const separator = url.includes("?") ? "&" : "?";
    const parent = document.getElementsByTagName("head")[0] || document.documentElement;

    const removeScript = () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };

    window[callbackName] = (data) => {
      delete window[callbackName];
      removeScript();
      resolve(data);
    };

    script.onerror = () => {
      delete window[callbackName];
      removeScript();
      reject(new Error("JSONP request failed"));
    };

    script.src = `${url.replace("/api/ezviz-live", "/api/ezviz-live-jsonp")}${separator}callback=${callbackName}`;
    parent.appendChild(script);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatRankedPlayerName(name, rank) {
  const cleanName = String(name || "").trim().replace(/\s+\([KIHGFEDCBA]\)$/i, "");
  const cleanRank = String(rank || "").trim().toUpperCase();
  return cleanRank ? `${cleanName} (${cleanRank})` : cleanName;
}

function splitRankedPlayerName(name, fallbackRank = "") {
  const value = String(name || "").trim();
  const match = value.match(/^(.*?)\s+\(([KIHGFEDCBA])\)$/i);
  return {
    name: match ? match[1].trim() : value,
    rank: (match?.[2] || fallbackRank || "—").toUpperCase(),
  };
}

function ensureTournamentLiveWindow() {
  let modal = document.querySelector("#tournamentLiveWindow");

  if (modal) {
    return modal;
  }

  modal = document.createElement("section");
  modal.id = "tournamentLiveWindow";
  modal.className = "tournament-live-window";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="tournament-live-backdrop" data-close-tournament-live></div>
    <div class="tournament-live-dialog" role="dialog" aria-modal="true" aria-labelledby="tournamentLiveTitle">
      <div class="tournament-live-header">
        <div>
          <p>LIVE EZVIZ</p>
          <h3 id="tournamentLiveTitle">Dang mo camera</h3>
        </div>
        <button class="tournament-live-close" data-close-tournament-live type="button" aria-label="Dong camera">x</button>
      </div>
      <div class="tournament-live-score" id="tournamentLiveScore"></div>
      <div class="tournament-live-preview" id="tournamentLivePreview">
        <span>Dang ket noi camera...</span>
      </div>
      <div class="tournament-live-status" id="tournamentLiveStatus">Dang goi EZVIZ...</div>
    </div>
  `;
  document.body.append(modal);

  modal.querySelectorAll("[data-close-tournament-live]").forEach((button) => {
    button.addEventListener("click", closeTournamentLiveWindow);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      closeTournamentLiveWindow();
    }
  });

  return modal;
}

function closeTournamentLiveWindow() {
  if (tournamentLivePlayer?.stop) {
    tournamentLivePlayer.stop();
  }
  tournamentLivePlayer = null;
  activeTournamentLiveMatch = null;

  const modal = document.querySelector("#tournamentLiveWindow");
  if (modal) {
    modal.hidden = true;
    modal.querySelector("#tournamentLivePreview").innerHTML = "<span>Dang ket noi camera...</span>";
  }
}

function renderTournamentLiveFallback(preview, url) {
  if (url?.includes(".m3u8") || url?.includes(".mp4")) {
    preview.innerHTML = `<video controls autoplay muted playsinline></video>`;
    const video = preview.querySelector("video");

    if (url.includes(".m3u8") && window.Hls?.isSupported()) {
      const hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }

    video.src = url;
    return;
  }

  preview.innerHTML = `<iframe src="${escapeHtml(url || "")}" title="EZVIZ live view" allowfullscreen></iframe>`;
}

function getMatchLiveInfo(matchCard) {
  if (!matchCard) {
    return {};
  }

  const players = [...matchCard.querySelectorAll(".player")].map((player) => ({
    name: player.querySelector(".name")?.textContent.trim() || "TBD",
    score: player.querySelector(".score-input")?.value || player.querySelector(".score")?.textContent.trim() || "-",
    winner: player.classList.contains("winner"),
  }));

  return {
    label: matchCard.dataset.matchLabel || "",
    table: matchCard.dataset.openMatchCamera,
    status: matchStatusLabel(matchCard.dataset.matchStatus),
    statusValue: matchCard.dataset.matchStatus || "pending",
    playerA: players[0]?.name || "TBD",
    scoreA: players[0]?.score || "-",
    playerB: players[1]?.name || "TBD",
    scoreB: players[1]?.score || "-",
    winnerA: !!players[0]?.winner,
    winnerB: !!players[1]?.winner,
    roundIndex: Number(matchCard.dataset.round),
    matchIndex: Number(matchCard.dataset.match),
  };
}

function getMatchLiveInfoFromState(roundIndex, matchIndex) {
  const match = state.rounds[roundIndex]?.matches[matchIndex];
  if (!match) {
    return {};
  }

  return {
    label: `Tran ${match.matchIndex + 1}`,
    table: Number(match.table) || matchIndex + 1,
    status: matchStatusLabel(match.status),
    statusValue: match.status || "pending",
    playerA: match.playerA || "TBD",
    scoreA: match.scoreA || "-",
    playerB: match.playerB || "TBD",
    scoreB: match.scoreB || "-",
    winnerA: match.winner === match.playerA,
    winnerB: match.winner === match.playerB,
    roundIndex,
    matchIndex,
  };
}

function isTournamentLiveShowingMatch(roundIndex, matchIndex) {
  const modal = document.querySelector("#tournamentLiveWindow");
  return !!modal && !modal.hidden && activeTournamentLiveMatch?.roundIndex === roundIndex && activeTournamentLiveMatch?.matchIndex === matchIndex;
}

function refreshOpenTournamentLiveScore(roundIndex, matchIndex) {
  if (!isTournamentLiveShowingMatch(roundIndex, matchIndex)) {
    return;
  }

  const modal = document.querySelector("#tournamentLiveWindow");
  renderTournamentLiveScore(modal, getMatchLiveInfoFromState(roundIndex, matchIndex));
}

function canOpenMatchLive(matchInfo = {}) {
  const hasPlayers = matchInfo.playerA && matchInfo.playerA !== "TBD" && matchInfo.playerB && matchInfo.playerB !== "TBD";
  return hasPlayers && matchInfo.status === "Đang đấu";
}

function matchStatusLabel(status) {
  if (status === "live") return "Đang đấu";
  if (status === "done") return "Kết thúc";
  return "Chưa đấu";
}

function renderTournamentLiveScore(modal, matchInfo = {}) {
  const score = modal.querySelector("#tournamentLiveScore");
  const playerA = escapeHtml(matchInfo.playerA || "TBD");
  const playerB = escapeHtml(matchInfo.playerB || "TBD");
  const scoreA = escapeHtml(matchInfo.scoreA === "-" ? "" : (matchInfo.scoreA || ""));
  const scoreB = escapeHtml(matchInfo.scoreB === "-" ? "" : (matchInfo.scoreB || ""));
  const status = escapeHtml(matchInfo.status || "Đang thi đấu");
  const statusValue = matchInfo.statusValue || "live";

  score.innerHTML = `
    <div class="live-score-player${matchInfo.winnerA ? " winner" : ""}">
      <strong>${playerA}</strong>
      ${isAdmin && Number.isInteger(matchInfo.roundIndex) && Number.isInteger(matchInfo.matchIndex)
        ? `<input class="live-score-input" data-live-score="scoreA" value="${scoreA}" inputmode="numeric" aria-label="Điểm ${playerA}" />`
        : `<span>${scoreA || "-"}</span>`}
    </div>
    <div class="live-score-divider">vs</div>
    <div class="live-score-player${matchInfo.winnerB ? " winner" : ""}">
      <strong>${playerB}</strong>
      ${isAdmin && Number.isInteger(matchInfo.roundIndex) && Number.isInteger(matchInfo.matchIndex)
        ? `<input class="live-score-input" data-live-score="scoreB" value="${scoreB}" inputmode="numeric" aria-label="Điểm ${playerB}" />`
        : `<span>${scoreB || "-"}</span>`}
    </div>
    ${isAdmin && Number.isInteger(matchInfo.roundIndex) && Number.isInteger(matchInfo.matchIndex)
      ? `<select class="live-status-select status-${escapeHtml(statusValue)}" data-live-status aria-label="Trạng thái trận đấu">
          <option value="pending"${statusValue !== "live" && statusValue !== "done" ? " selected" : ""}>Chưa đấu</option>
          <option value="live"${statusValue === "live" ? " selected" : ""}>Đang đấu</option>
          <option value="done"${statusValue === "done" ? " selected" : ""}>Kết thúc</option>
        </select>`
      : `<small>${status}</small>`}
  `;
  score.querySelectorAll("[data-live-score]").forEach((input) => {
    input.addEventListener("change", () => {
      updateMatchScore(matchInfo.roundIndex, matchInfo.matchIndex, input.dataset.liveScore, input.value.trim());
      refreshOpenTournamentLiveScore(matchInfo.roundIndex, matchInfo.matchIndex);
    });
  });
  score.querySelector("[data-live-status]")?.addEventListener("change", (event) => {
    updateMatchStatus(matchInfo.roundIndex, matchInfo.matchIndex, event.target.value);
    const current = state.rounds[matchInfo.roundIndex]?.matches[matchInfo.matchIndex];
    if (current) {
      renderTournamentLiveScore(modal, {
        ...matchInfo,
        scoreA: current.scoreA,
        scoreB: current.scoreB,
        status: matchStatusLabel(current.status),
        statusValue: current.status,
        winnerA: current.winner === current.playerA,
        winnerB: current.winner === current.playerB,
      });
    }
  });
}

async function openTournamentLiveWindow(table, matchInfo = "") {
  const tableNumber = String(table || 1).replace(/\D/g, "").padStart(2, "0");
  const info = typeof matchInfo === "string" ? { label: matchInfo } : matchInfo || {};

  if (info.label && !canOpenMatchLive(info)) {
    alert("Chỉ mở camera cho trận đang diễn ra.");
    return;
  }

  const modal = ensureTournamentLiveWindow();
  const title = modal.querySelector("#tournamentLiveTitle");
  const preview = modal.querySelector("#tournamentLivePreview");
  const status = modal.querySelector("#tournamentLiveStatus");

  modal.hidden = false;
  activeTournamentLiveMatch = Number.isInteger(info.roundIndex) && Number.isInteger(info.matchIndex)
    ? { roundIndex: info.roundIndex, matchIndex: info.matchIndex }
    : null;
  title.textContent = `${info.label ? `${info.label} - ` : ""}Ban ${tableNumber}`;
  renderTournamentLiveScore(modal, { ...info, table: tableNumber });
  preview.classList.remove("live-mode");
  preview.innerHTML = "<span>Dang ket noi camera...</span>";
  status.textContent = "Dang goi live EZVIZ...";

  if (tournamentLivePlayer?.stop) {
    tournamentLivePlayer.stop();
  }
  tournamentLivePlayer = null;

  try {
    const data = await getJson(`/api/ezviz-live?table=${tableNumber}`);

    if (!data.ok) {
      preview.innerHTML = `<span>${escapeHtml(data.message || "Chua mo duoc camera.")}</span>`;
      status.textContent = data.message || "Chua nhan duoc camera.";
      return;
    }

    preview.classList.add("live-mode");

    if (!window.EZUIKit?.EZUIKitPlayer || !data.ezopenUrl || !data.accessToken) {
      renderTournamentLiveFallback(preview, data.liveUrl || data.ezopenUrl);
      status.textContent = `${title.textContent} dang xem truc tiep.`;
      return;
    }

    preview.innerHTML = `<div id="tournamentEzvizPlayer"></div>`;
    const width = preview.clientWidth || 960;
    const height = Math.round(width * 0.5625);

    tournamentLivePlayer = new EZUIKit.EZUIKitPlayer({
      id: "tournamentEzvizPlayer",
      accessToken: data.accessToken,
      url: data.ezopenUrl,
      validCode: data.validCode || undefined,
      width,
      height,
      autoplay: true,
      template: "simple",
      fit: "contain",
      objectFit: "contain",
      env: data.apiBase ? { domain: data.apiBase } : undefined,
      handleError: (error) => {
        status.textContent = `EZVIZ player error: ${JSON.stringify(error)}`;
      },
    });

    status.textContent = `${title.textContent} dang xem truc tiep.`;
  } catch (error) {
    preview.innerHTML = `<span>Khong goi duoc camera.</span>`;
    status.textContent = `Khong goi duoc camera: ${error.message}`;
  }
}

window.openTournamentCameraTable = openTournamentLiveWindow;

function nextPowerOfTwo(value) {
  return 2 ** Math.ceil(Math.log2(Math.max(value, 2)));
}

function shuffledItems(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function roundTitles(size) {
  const map = {
    2: ["Chung kết"],
    4: ["Bán kết", "Chung kết"],
    8: ["Tứ kết", "Bán kết", "Chung kết"],
    16: ["Vòng 1/8", "Tứ kết", "Bán kết", "Chung kết"],
    32: ["Vòng 1/16", "Vòng 1/8", "Tứ kết", "Bán kết", "Chung kết"],
  };
  return map[size] || map[16];
}

function groupLabel(index) {
  let value = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function groupedRoundTitle(roundIndex, playerCount) {
  if (roundIndex === 0) return "Vòng bảng";
  if (playerCount === 2) return "Chung kết";
  if (playerCount === 4) return "Bán kết";
  if (playerCount === 8) return "Tứ kết";
  if (playerCount === 16) return "Vòng 1/8";
  if (playerCount === 32) return "Vòng 1/16";
  return `Vòng ${roundIndex + 1}`;
}

function makeMatch(roundIndex, matchIndex, playerA = null, playerB = null) {
  return {
    id: `r${roundIndex + 1}m${matchIndex + 1}`,
    roundIndex,
    matchIndex,
    table: (matchIndex % tableCount) + 1,
    time: "",
    playerA,
    playerB,
    scoreA: "",
    scoreB: "",
    status: playerA || playerB ? "pending" : "waiting",
    winner: null,
  };
}

function isGroupedRound(round) {
  return round?.bracketGroup === "grouped";
}

function groupedRoundPlayerNames(round) {
  const names = [];
  (round?.matches || []).forEach((match) => {
    if (match.playerA) names.push(match.playerA);
    if (match.playerB) names.push(match.playerB);
  });
  return [...new Set(names)];
}

function groupedRoundWinners(round) {
  if (isGroupedRound(round) && (round.matches || []).some((match) => match.groupRole)) {
    return groupedRoundQualifiers(round);
  }
  return (round?.matches || [])
    .filter((match) => match.status === "done" && match.winner)
    .map((match) => match.winner);
}

function matchLoser(match) {
  if (!match?.winner || !match.playerA || !match.playerB) return null;
  return match.winner === match.playerA ? match.playerB : match.playerA;
}

function groupedRoundQualifiers(round) {
  const qualifiers = [];
  (round?.groups || []).forEach((group) => {
    const groupMatches = (round.matches || []).filter((match) => match.groupIndex === group.index);
    const winnersMatch = groupMatches.find((match) => match.groupRole === "winners");
    const deciderMatch = groupMatches.find((match) => match.groupRole === "decider");
    const finalMatch = groupMatches.find((match) => match.groupRole === "final");
    if (winnersMatch?.winner) qualifiers.push(winnersMatch.winner);
    if (deciderMatch?.winner) qualifiers.push(deciderMatch.winner);
    if (finalMatch?.winner) qualifiers.push(finalMatch.winner);
  });
  return qualifiers;
}

function makeGroupedMatch(roundIndex, matches, groupIndex, groupLabelText, role, label, playerA = null, playerB = null) {
  const match = makeMatch(roundIndex, matches.length, playerA, playerB);
  match.id = `grouped-r${roundIndex + 1}g${groupIndex + 1}m${matches.length + 1}`;
  match.bracketGroup = "grouped";
  match.groupIndex = groupIndex;
  match.groupLabel = groupLabelText;
  match.groupRole = role;
  match.groupMatchLabel = label;
  match.seedA = playerA;
  match.seedB = playerB;
  match.status = playerA && playerB ? "pending" : "waiting";
  return match;
}

function recalculateGroupedRoundObject(round) {
  if (!isGroupedRound(round)) return;
  (round.groups || []).forEach((group) => {
    const groupMatches = round.matches.filter((match) => match.groupIndex === group.index);
    const openings = groupMatches.filter((match) => match.groupRole === "opening");
    const winnersMatch = groupMatches.find((match) => match.groupRole === "winners");
    const losersMatch = groupMatches.find((match) => match.groupRole === "losers");
    const deciderMatch = groupMatches.find((match) => match.groupRole === "decider");
    if (!winnersMatch || !losersMatch || !deciderMatch) return;

    const saved = new Map([winnersMatch, losersMatch, deciderMatch].map((match) => [match.groupRole, {
      scoreA: match.scoreA,
      scoreB: match.scoreB,
      status: match.status,
      winner: match.winner,
    }]));
    [winnersMatch, losersMatch, deciderMatch].forEach((match) => {
      match.playerA = null;
      match.playerB = null;
      match.scoreA = "";
      match.scoreB = "";
      match.winner = null;
      match.status = "waiting";
    });

    if (openings.every((match) => match.status === "done" && match.winner)) {
      winnersMatch.playerA = openings[0].winner;
      winnersMatch.playerB = openings[1].winner;
      losersMatch.playerA = matchLoser(openings[0]);
      losersMatch.playerB = matchLoser(openings[1]);
    }

    [winnersMatch, losersMatch].forEach((match) => {
      const old = saved.get(match.groupRole);
      if (match.playerA && match.playerB) {
        match.status = "pending";
        if (old?.status === "done" && old.winner && [match.playerA, match.playerB].includes(old.winner)) {
          match.scoreA = old.scoreA;
          match.scoreB = old.scoreB;
          match.status = "done";
          match.winner = old.winner;
        }
      }
    });

    if (winnersMatch.status === "done" && winnersMatch.winner && losersMatch.status === "done" && losersMatch.winner) {
      deciderMatch.playerA = matchLoser(winnersMatch);
      deciderMatch.playerB = losersMatch.winner;
      const old = saved.get("decider");
      deciderMatch.status = "pending";
      if (old?.status === "done" && old.winner && [deciderMatch.playerA, deciderMatch.playerB].includes(old.winner)) {
        deciderMatch.scoreA = old.scoreA;
        deciderMatch.scoreB = old.scoreB;
        deciderMatch.status = "done";
        deciderMatch.winner = old.winner;
      }
    }
  });
}

function recalculateGroupedRound(roundIndex) {
  recalculateGroupedRoundObject(state.rounds[roundIndex]);
}

function recalculateGroupedRoundsFrom(roundIndex) {
  for (let index = roundIndex; index < state.rounds.length; index += 1) {
    recalculateGroupedRound(index);
  }
}

function buildGroupedRound(playerNames, roundIndex, mode = "random") {
  const sourcePlayers = [...playerNames];
  const shouldFill = mode !== "empty";
  const slots = mode === "random"
    ? shuffledItems(sourcePlayers)
    : shouldFill
    ? [...sourcePlayers]
    : Array.from({ length: sourcePlayers.length }, () => null);
  const matches = [];
  const playersPerGroup = sourcePlayers.length <= 2 ? 2 : 4;
  const groupCount = Math.max(1, Math.ceil(sourcePlayers.length / playersPerGroup));
  const groups = [];

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const groupPlayers = slots.slice(groupIndex * playersPerGroup, groupIndex * playersPerGroup + playersPerGroup);
    const label = groupCount > 1 || roundIndex === 0 ? `Bảng ${groupLabel(groupIndex)}` : groupedRoundTitle(roundIndex, sourcePlayers.length);
    groups.push({ index: groupIndex, label });
    if (playersPerGroup === 2) {
      matches.push(makeGroupedMatch(roundIndex, matches, groupIndex, label, "final", "Chung kết", groupPlayers[0] || null, groupPlayers[1] || null));
      continue;
    }
    matches.push(makeGroupedMatch(roundIndex, matches, groupIndex, label, "opening", "Mở màn 1", groupPlayers[0] || null, groupPlayers[1] || null));
    matches.push(makeGroupedMatch(roundIndex, matches, groupIndex, label, "opening", "Mở màn 2", groupPlayers[2] || null, groupPlayers[3] || null));
    matches.push(makeGroupedMatch(roundIndex, matches, groupIndex, label, "winners", "Thắng gặp thắng", null, null));
    matches.push(makeGroupedMatch(roundIndex, matches, groupIndex, label, "losers", "Thua gặp thua", null, null));
    matches.push(makeGroupedMatch(roundIndex, matches, groupIndex, label, "decider", "Trận quyết định", null, null));
  }

  const round = {
    title: groupedRoundTitle(roundIndex, sourcePlayers.length),
    bracketGroup: "grouped",
    formatType: "double",
    formatLabel: "2 mạng",
    sourcePlayers,
    groups,
    mode,
    matches,
  };
  recalculateGroupedRoundObject(round);
  return round;
}

function buildSingleEliminationRound(playerNames, roundIndex) {
  const sourcePlayers = [...playerNames];
  const matches = [];
  for (let index = 0; index < sourcePlayers.length; index += 2) {
    const playerA = sourcePlayers[index] || null;
    const playerB = sourcePlayers[index + 1] || null;
    const match = makeMatch(roundIndex, matches.length, playerA, playerB);
    match.id = `single-r${roundIndex + 1}m${matches.length + 1}`;
    match.bracketGroup = "single-elimination";
    match.groupMatchLabel = `Trận ${matches.length + 1}`;
    match.seedA = playerA;
    match.seedB = playerB;
    if (playerA && !playerB) {
      match.scoreA = "W";
      match.winner = playerA;
      match.status = "done";
      match.allowSingleAdvance = true;
    }
    matches.push(match);
  }
  return {
    title: groupedRoundTitle(roundIndex, sourcePlayers.length),
    bracketGroup: "single-elimination",
    formatType: "single",
    formatLabel: "Loại trực tiếp",
    sourcePlayers,
    matches,
  };
}

function recordStatsFromRounds(rounds = state.rounds) {
  const stats = new Map(state.players.map((player) => [player.name, { wins: 0, losses: 0, byes: 0, opponents: new Set() }]));
  rounds.forEach((round) => (round.matches || []).forEach((match) => {
    if (match.status !== "done" || !match.winner || !match.playerA) return;
    if (!stats.has(match.playerA)) stats.set(match.playerA, { wins: 0, losses: 0, byes: 0, opponents: new Set() });
    if (!match.playerB) {
      stats.get(match.playerA).byes += 1;
      return;
    }
    if (!stats.has(match.playerB)) stats.set(match.playerB, { wins: 0, losses: 0, byes: 0, opponents: new Set() });
    const loser = match.winner === match.playerA ? match.playerB : match.playerA;
    stats.get(match.winner).wins += 1;
    stats.get(loser).losses += 1;
    stats.get(match.playerA).opponents.add(match.playerB);
    stats.get(match.playerB).opponents.add(match.playerA);
  }));
  return stats;
}

function buildRecordRound(playerNames, roundIndex, stats, isFinal = false) {
  const remaining = shuffledItems(playerNames);
  const matches = [];
  let byePlayer = null;
  if (remaining.length % 2 === 1) {
    const fewestByes = Math.min(...remaining.map((name) => stats.get(name)?.byes || 0));
    const byeCandidates = remaining.filter((name) => (stats.get(name)?.byes || 0) === fewestByes);
    byePlayer = byeCandidates[Math.floor(Math.random() * byeCandidates.length)];
    remaining.splice(remaining.indexOf(byePlayer), 1);
  }
  while (remaining.length) {
    const playerA = remaining.shift();
    const statA = stats.get(playerA) || { wins: 0, losses: 0, byes: 0, opponents: new Set() };
    let opponentIndex = remaining.findIndex((name) => !statA.opponents.has(name));
    if (opponentIndex < 0 && remaining.length) opponentIndex = 0;
    const playerB = opponentIndex >= 0 ? remaining.splice(opponentIndex, 1)[0] : null;
    const statB = playerB ? (stats.get(playerB) || { wins: 0, losses: 0 }) : null;
    const match = makeMatch(roundIndex, matches.length, playerA, playerB);
    match.id = `record-r${roundIndex + 1}m${matches.length + 1}`;
    match.bracketGroup = isFinal ? "record-final" : "record";
    match.recordA = `${statA.wins}-${statA.losses}`;
    match.recordB = statB ? `${statB.wins}-${statB.losses}` : "BYE";
    if (!playerB) {
      match.scoreA = "W";
      match.winner = playerA;
      match.status = "done";
    }
    matches.push(match);
  }
  if (byePlayer) {
    const stat = stats.get(byePlayer) || { wins: 0, losses: 0 };
    const byeMatch = makeMatch(roundIndex, matches.length, byePlayer, null);
    byeMatch.id = `record-r${roundIndex + 1}m${matches.length + 1}`;
    byeMatch.bracketGroup = isFinal ? "record-final" : "record";
    byeMatch.recordA = `${stat.wins}-${stat.losses}`;
    byeMatch.recordB = "BYE";
    byeMatch.scoreA = "W";
    byeMatch.winner = byePlayer;
    byeMatch.status = "done";
    matches.push(byeMatch);
  }
  return {
    title: isFinal ? "Chung kết" : `Vòng ${roundIndex + 1} • Bốc cặp ngẫu nhiên`,
    bracketGroup: isFinal ? "record-final" : "record",
    matches,
  };
}

function maybeGenerateRecordRound() {
  const lastRound = state.rounds[state.rounds.length - 1];
  if (!lastRound || !lastRound.matches.every((match) => match.status === "done")) return;
  if (lastRound.bracketGroup === "record-final") return;
  const stats = recordStatsFromRounds();
  const active = [...stats.entries()].filter(([, value]) => value.losses < 2).map(([name]) => name);
  if (active.length < 2) return;
  const nextIndex = state.rounds.length;
  state.rounds.push(buildRecordRound(active, nextIndex, stats, active.length === 2));
}

function setMatchRoute(match, kind, round, targetMatch, slot) {
  match[kind] = { round, match: targetMatch, slot };
}

function buildDiagramBracket(slots) {
  const size = slots.length;
  const winnerCounts = [];
  for (let count = size / 2; count >= 1; count = Math.ceil(count / 2)) {
    winnerCounts.push(count);
    if (count === 1) break;
  }
  const winnerRoundCount = winnerCounts.length;
  const loserCounts = [Math.ceil(winnerCounts[0] / 2), Math.ceil(winnerCounts[0] / 2)];
  while (loserCounts.length < winnerRoundCount) loserCounts.push(Math.ceil(loserCounts[loserCounts.length - 1] / 2));
  const winnerDefinitions = winnerCounts.map((count, index) => ({
    title: index === 0 ? "Vòng đầu" : index === winnerRoundCount - 1 ? "Chung kết nhánh thắng" : index === winnerRoundCount - 2 ? "Bán kết nhánh thắng" : `Vòng ${index + 1} nhánh thắng`,
    group: "diagram-winner",
    count,
  }));
  const loserDefinitions = loserCounts.map((count, index) => ({
    title: index === 0 ? "Cơ hội thứ hai" : index === winnerRoundCount - 1 ? "Chung kết nhánh thua" : index === winnerRoundCount - 2 ? "Bán kết nhánh thua" : `Vòng ${index + 1} nhánh thua`,
    group: "diagram-loser",
    count,
  }));
  const definitions = [...winnerDefinitions, ...loserDefinitions, { title: "CHUNG KẾT", group: "diagram-grand", count: 1 }];
  const rounds = definitions.map((definition, roundIndex) => ({
    title: definition.title,
    bracketGroup: definition.group,
    matches: Array.from({ length: definition.count }, (_, matchIndex) => {
      const playerA = roundIndex === 0 ? slots[matchIndex * 2] : null;
      const playerB = roundIndex === 0 ? slots[matchIndex * 2 + 1] : null;
      const match = makeMatch(roundIndex, matchIndex, playerA, playerB);
      match.id = `diagram-r${roundIndex + 1}m${matchIndex + 1}`;
      match.bracketGroup = definition.group;
      match.seedA = playerA;
      match.seedB = playerB;
      return match;
    }),
  }));

  // Nhánh thắng tiến dần vào giữa.
  for (let r = 0; r < winnerRoundCount - 1; r += 1) {
    rounds[r].matches.forEach((match, index) => {
      setMatchRoute(match, "nextWin", r + 1, Math.floor(index / 2), index % 2 ? "playerB" : "playerA");
    });
    if (rounds[r].matches.length % 2 === 1) {
      rounds[r + 1].matches[rounds[r + 1].matches.length - 1].allowSingleAdvance = true;
    }
  }
  const loserStart = winnerRoundCount;
  const grandRound = winnerRoundCount * 2;
  rounds[0].matches.forEach((match) => {
    match.allowSingleAdvance = true;
  });
  rounds[loserStart].matches.forEach((match) => {
    match.allowSingleAdvance = true;
  });
  setMatchRoute(rounds[winnerRoundCount - 1].matches[0], "nextWin", grandRound, 0, "playerA");

  // Người thua vòng đầu gặp nhau, sau đó gặp người thua ở tứ kết nhánh thắng.
  rounds[0].matches.forEach((match, index) => {
    setMatchRoute(match, "nextLoss", loserStart, Math.floor(index / 2), index % 2 ? "playerB" : "playerA");
  });
  rounds[loserStart].matches.forEach((match, index) => setMatchRoute(match, "nextWin", loserStart + 1, index, "playerA"));
  rounds[1].matches.forEach((match, index) => setMatchRoute(match, "nextLoss", loserStart + 1, index, "playerB"));
  for (let index = 1; index < winnerRoundCount - 1; index += 1) {
    rounds[loserStart + index].matches.forEach((match, matchIndex) => {
      setMatchRoute(match, "nextWin", loserStart + index + 1, Math.floor(matchIndex / 2), matchIndex % 2 ? "playerB" : "playerA");
    });
    if (rounds[loserStart + index].matches.length % 2 === 1) {
      rounds[loserStart + index + 1].matches[rounds[loserStart + index + 1].matches.length - 1].allowSingleAdvance = true;
    }
  }
  setMatchRoute(rounds[loserStart + winnerRoundCount - 1].matches[0], "nextWin", grandRound, 0, "playerB");
  return rounds;
}

function distributeDiagramSlots(playerNames, size) {
  if (playerNames.length === size) return [...playerNames];
  const pairCount = size / 2;
  const byeCount = size - playerNames.length;
  const byePairs = new Set(Array.from({ length: byeCount }, (_, index) => (index * 2) % pairCount));
  const result = [];
  let playerIndex = 0;
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    result.push(playerNames[playerIndex++] || null);
    result.push(byePairs.has(pairIndex) ? null : (playerNames[playerIndex++] || null));
  }
  return result;
}

function buildDoubleEliminationBracket(slots, size) {
  const winnerTitles = roundTitles(size);
  const rounds = winnerTitles.map((title, roundIndex) => ({
    title: `Nhánh thắng • ${title}`,
    bracketGroup: "winner",
    matches: Array.from({ length: size / 2 ** (roundIndex + 1) }, (_, matchIndex) => {
      const match = makeMatch(roundIndex, matchIndex, roundIndex === 0 ? slots[matchIndex * 2] : null, roundIndex === 0 ? slots[matchIndex * 2 + 1] : null);
      match.id = `w${roundIndex + 1}m${matchIndex + 1}`;
      match.seedA = match.playerA;
      match.seedB = match.playerB;
      match.bracketGroup = "winner";
      return match;
    }),
  }));

  const winnerRoundCount = winnerTitles.length;
  const loserRoundCount = Math.max(0, winnerRoundCount * 2 - 2);
  for (let loserIndex = 0; loserIndex < loserRoundCount; loserIndex += 1) {
    const pair = Math.floor(loserIndex / 2);
    const matchCount = size / 2 ** (pair + 2);
    const roundIndex = rounds.length;
    rounds.push({
      title: `Nhánh thua • Vòng ${loserIndex + 1}`,
      bracketGroup: "loser",
      matches: Array.from({ length: matchCount }, (_, matchIndex) => {
        const match = makeMatch(roundIndex, matchIndex);
        match.id = `l${loserIndex + 1}m${matchIndex + 1}`;
        match.bracketGroup = "loser";
        return match;
      }),
    });
  }

  const grandRound = rounds.length;
  rounds.push({
    title: "Chung kết tổng",
    bracketGroup: "final",
    matches: [makeMatch(grandRound, 0), makeMatch(grandRound, 1)],
  });
  rounds[grandRound].matches[0].id = "gf1";
  rounds[grandRound].matches[0].bracketGroup = "final";
  rounds[grandRound].matches[1].id = "gf2";
  rounds[grandRound].matches[1].bracketGroup = "final";
  rounds[grandRound].matches[1].isResetFinal = true;

  // Winner bracket routes.
  for (let r = 0; r < winnerRoundCount; r += 1) {
    rounds[r].matches.forEach((match, i) => {
      if (r < winnerRoundCount - 1) {
        setMatchRoute(match, "nextWin", r + 1, Math.floor(i / 2), i % 2 ? "playerB" : "playerA");
      } else {
        setMatchRoute(match, "nextWin", grandRound, 0, "playerA");
      }
      if (!loserRoundCount) {
        setMatchRoute(match, "nextLoss", grandRound, 0, "playerB");
        return;
      }
      if (r === 0) {
        setMatchRoute(match, "nextLoss", winnerRoundCount, Math.floor(i / 2), i % 2 ? "playerB" : "playerA");
      } else {
        const loserRound = winnerRoundCount + (r * 2 - 1);
        const targetCount = rounds[loserRound].matches.length;
        setMatchRoute(match, "nextLoss", loserRound, targetCount - 1 - i, "playerB");
      }
    });
  }

  // Loser bracket alternates between accepting a winner-bracket loser and halving its field.
  for (let j = 0; j < loserRoundCount; j += 1) {
    const roundIndex = winnerRoundCount + j;
    rounds[roundIndex].matches.forEach((match, i) => {
      if (j === loserRoundCount - 1) {
        setMatchRoute(match, "nextWin", grandRound, 0, "playerB");
      } else if (j % 2 === 0) {
        setMatchRoute(match, "nextWin", roundIndex + 1, i, "playerA");
      } else {
        setMatchRoute(match, "nextWin", roundIndex + 1, Math.floor(i / 2), i % 2 ? "playerB" : "playerA");
      }
    });
  }
  return rounds;
}

function recalculateDoubleBracket() {
  const saved = new Map(state.rounds.flatMap((round) => round.matches).map((match) => [match.id, {
    playerA: match.playerA, playerB: match.playerB, scoreA: match.scoreA, scoreB: match.scoreB, status: match.status,
  }]));

  for (let pass = 0; pass < state.rounds.length + 3; pass += 1) {
    state.rounds.forEach((round) => round.matches.forEach((match) => {
      match.playerA = Object.prototype.hasOwnProperty.call(match, "manualPlayerA") ? match.manualPlayerA : (match.seedA || null);
      match.playerB = Object.prototype.hasOwnProperty.call(match, "manualPlayerB") ? match.manualPlayerB : (match.seedB || null);
      match.winner = null;
      match.status = match.playerA || match.playerB ? "waiting" : "waiting";
      match.scoreA = "";
      match.scoreB = "";
    }));

    state.rounds.forEach((round) => round.matches.forEach((match) => {
      const old = saved.get(match.id);
      if (old && old.playerA === match.playerA && old.playerB === match.playerB) {
        match.scoreA = old.scoreA;
        match.scoreB = old.scoreB;
        match.status = old.status === "live" || old.status === "done" ? old.status : (match.playerA && match.playerB ? "pending" : "waiting");
      }
      let winner = null;
      let loser = null;
      const a = Number(match.scoreA);
      const b = Number(match.scoreB);
      if (match.status === "done" && match.playerA && match.playerB && Number.isFinite(a) && Number.isFinite(b) && a !== b && match.scoreA !== "" && match.scoreB !== "") {
        winner = a > b ? match.playerA : match.playerB;
        loser = a > b ? match.playerB : match.playerA;
      } else if ((match.bracketGroup === "winner" || match.allowSingleAdvance) && match.playerA && !match.playerB) {
        winner = match.playerA;
        match.scoreA = "W";
      } else if ((match.bracketGroup === "winner" || match.allowSingleAdvance) && !match.playerA && match.playerB) {
        winner = match.playerB;
        match.scoreB = "W";
      }
      if (!winner) {
        if (match.status !== "live") match.status = match.playerA && match.playerB ? "pending" : "waiting";
        return;
      }
      match.winner = winner;
      match.status = "done";
      [ [match.nextWin, winner], [match.nextLoss, loser] ].forEach(([route, player]) => {
        if (route && player) {
          const targetMatch = state.rounds[route.round].matches[route.match];
          const manualField = route.slot === "playerA" ? "manualPlayerA" : "manualPlayerB";
          if (!Object.prototype.hasOwnProperty.call(targetMatch, manualField)) targetMatch[route.slot] = player;
        }
      });
      if (match.id === "gf1" && winner === match.playerB) {
        const reset = state.rounds[match.roundIndex].matches[1];
        reset.playerA = match.playerA;
        reset.playerB = match.playerB;
      }
    }));
  }
}

function buildBracket(randomize = false) {
  if (!isAdmin) {
    return;
  }

  if (state.players.length < 2) {
    alert("Cần ít nhất 2 cơ thủ để tạo bracket.");
    return;
  }

  if (state.rounds.length && !confirm("Chia lại sơ đồ đấu sẽ xoá điểm và kết quả hiện tại. Tiếp tục?")) {
    return;
  }

  const bracketPlayers = randomize ? shuffledItems(state.players) : state.players;
  state.rounds = [buildGroupedRound(bracketPlayers.map((player) => player.name), 0, randomize ? "random" : "ordered")];
  selectedDetailRoundIndex = 0;
  selectedBracketRoundIndex = 0;
  saveState();
  renderAll();
}

function autoAdvanceByes() {
  state.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      if (match.playerA && !match.playerB) {
        match.scoreA = "W";
        match.winner = match.playerA;
        match.status = "done";
        advanceWinner(match);
      }

      if (!match.playerA && match.playerB) {
        match.scoreB = "W";
        match.winner = match.playerB;
        match.status = "done";
        advanceWinner(match);
      }
    });
  });
}

function advanceWinner(match) {
  const nextRound = state.rounds[match.roundIndex + 1];
  if (!nextRound || !match.winner) {
    return;
  }

  const nextMatch = nextRound.matches[Math.floor(match.matchIndex / 2)];
  const target = match.matchIndex % 2 === 0 ? "playerA" : "playerB";
  nextMatch[target] = match.winner;
  if (nextMatch.playerA || nextMatch.playerB) {
    nextMatch.status = nextMatch.playerA && nextMatch.playerB ? "pending" : "waiting";
  }
}

function clearDownstream(roundIndex, matchIndex) {
  let sourceMatchIndex = matchIndex;

  for (let index = roundIndex + 1; index < state.rounds.length; index += 1) {
    const match = state.rounds[index].matches[Math.floor(sourceMatchIndex / 2)];
    const target = sourceMatchIndex % 2 === 0 ? "playerA" : "playerB";
    match[target] = null;
    match.scoreA = "";
    match.scoreB = "";
    match.winner = null;
    match.status = match.playerA || match.playerB ? "pending" : "waiting";
    sourceMatchIndex = Math.floor(sourceMatchIndex / 2);
  }
}

function isRoutedBracketMatch(match) {
  return ["winner", "loser", "final", "diagram-winner", "diagram-loser", "diagram-grand"].includes(match?.bracketGroup);
}

function updateMatchPlayers(roundIndex, matchIndex, playerA, playerB) {
  if (!isAdmin) return;
  const match = state.rounds[roundIndex]?.matches[matchIndex];
  const round = state.rounds[roundIndex];
  if (!match || (playerA && playerB && playerA === playerB)) return;
  if (isGroupedRound(round)) {
    if (!["opening", "final"].includes(match.groupRole)) {
      alert("Trận này sẽ tự lấy cơ thủ theo kết quả trận trước.");
      return;
    }
    const eligible = new Set(round.sourcePlayers || []);
    if ((playerA && !eligible.has(playerA)) || (playerB && !eligible.has(playerB))) {
      alert("Cơ thủ này không thuộc danh sách của vòng đấu hiện tại.");
      return;
    }
    const usedByOtherMatches = new Set();
    (round.matches || []).forEach((item, index) => {
      if (index === matchIndex) return;
      if (!["opening", "final"].includes(item.groupRole)) return;
      if (item.playerA) usedByOtherMatches.add(item.playerA);
      if (item.playerB) usedByOtherMatches.add(item.playerB);
    });
    if ((playerA && usedByOtherMatches.has(playerA)) || (playerB && usedByOtherMatches.has(playerB))) {
      alert("Cơ thủ này đã được xếp ở trận khác trong cùng vòng.");
      return;
    }
  }
  if (playerA) match.manualPlayerA = playerA;
  else delete match.manualPlayerA;
  if (playerB) match.manualPlayerB = playerB;
  else delete match.manualPlayerB;
  match.playerA = playerA;
  match.playerB = playerB;
  match.scoreA = "";
  match.scoreB = "";
  match.winner = null;
  match.status = playerA && playerB ? "pending" : "waiting";
  if (isGroupedRound(round)) {
    state.rounds = state.rounds.slice(0, roundIndex + 1);
    recalculateGroupedRound(roundIndex);
  } else if (isRoutedBracketMatch(match)) recalculateDoubleBracket();
  else clearDownstream(roundIndex, matchIndex);
  saveState();
  renderAll();
}

function updateMatchScore(roundIndex, matchIndex, field, value) {
  if (!isAdmin) {
    return;
  }

  const match = state.rounds[roundIndex]?.matches[matchIndex];
  if (!match) {
    return;
  }

  match[field] = value;
  if (isGroupedRound(state.rounds[roundIndex])) {
    const scoreA = Number(match.scoreA);
    const scoreB = Number(match.scoreB);
    if (match.status === "done" && match.playerA && match.playerB && Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB && match.scoreA !== "" && match.scoreB !== "") {
      state.rounds = state.rounds.slice(0, roundIndex + 1);
      match.winner = scoreA > scoreB ? match.playerA : match.playerB;
      recalculateGroupedRound(roundIndex);
    } else if (match.status === "done") {
      state.rounds = state.rounds.slice(0, roundIndex + 1);
      match.winner = null;
      match.status = match.playerA && match.playerB ? "pending" : "waiting";
      recalculateGroupedRound(roundIndex);
    }
    saveState();
    renderAll();
    refreshOpenTournamentLiveScore(roundIndex, matchIndex);
    return;
  }
  if (match.bracketGroup === "record" || match.bracketGroup === "record-final") {
    if (match.status === "done") {
      state.rounds = state.rounds.slice(0, roundIndex + 1);
      const scoreA = Number(match.scoreA);
      const scoreB = Number(match.scoreB);
      if (match.scoreA !== "" && match.scoreB !== "" && Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB) {
        match.winner = scoreA > scoreB ? match.playerA : match.playerB;
        maybeGenerateRecordRound();
      } else {
        match.winner = null;
        match.status = "pending";
      }
    }
    saveState();
    renderAll();
    refreshOpenTournamentLiveScore(roundIndex, matchIndex);
    return;
  }
  if (isRoutedBracketMatch(match)) {
    recalculateDoubleBracket();
    saveState();
    renderAll();
    refreshOpenTournamentLiveScore(roundIndex, matchIndex);
    return;
  }
  const scoreA = Number(match.scoreA);
  const scoreB = Number(match.scoreB);

  if (match.status === "done" && match.playerA && match.playerB && Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB && match.scoreA !== "" && match.scoreB !== "") {
    clearDownstream(roundIndex, matchIndex);
    match.winner = scoreA > scoreB ? match.playerA : match.playerB;
    advanceWinner(match);
  } else if (match.status === "done") {
    clearDownstream(roundIndex, matchIndex);
    match.winner = null;
    match.status = match.playerA && match.playerB ? "pending" : "waiting";
  }

  saveState();
  renderAll();
  refreshOpenTournamentLiveScore(roundIndex, matchIndex);
}

function updateMatchStatus(roundIndex, matchIndex, nextStatus) {
  if (!isAdmin) return;
  const match = state.rounds[roundIndex]?.matches[matchIndex];
  if (!match) return;

  if ((nextStatus === "live" || nextStatus === "done") && (!match.playerA || !match.playerB)) {
    alert("Trận đấu cần đủ 2 người chơi trước khi đổi trạng thái.");
    renderAll();
    return;
  }

  const scoreA = Number(match.scoreA);
  const scoreB = Number(match.scoreB);
  if (nextStatus === "done" && (match.scoreA === "" || match.scoreB === "" || !Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB)) {
    alert("Hãy nhập điểm hợp lệ và khác nhau trước khi kết thúc trận.");
    renderAll();
    return;
  }

  const wasDone = match.status === "done";
  match.status = nextStatus;
  if (isGroupedRound(state.rounds[roundIndex])) {
    if (wasDone || nextStatus === "done") state.rounds = state.rounds.slice(0, roundIndex + 1);
    match.winner = null;
    if (nextStatus === "done") {
      match.winner = scoreA > scoreB ? match.playerA : match.playerB;
    }
    recalculateGroupedRound(roundIndex);
  } else if (match.bracketGroup === "record" || match.bracketGroup === "record-final") {
    if (wasDone || nextStatus === "done") state.rounds = state.rounds.slice(0, roundIndex + 1);
    match.winner = null;
    if (nextStatus === "done") {
      match.winner = scoreA > scoreB ? match.playerA : match.playerB;
      maybeGenerateRecordRound();
    }
  } else if (isRoutedBracketMatch(match)) {
    recalculateDoubleBracket();
  } else {
    if (wasDone || nextStatus === "done") clearDownstream(roundIndex, matchIndex);
    match.winner = null;
    if (nextStatus === "done") {
      match.winner = scoreA > scoreB ? match.playerA : match.playerB;
      advanceWinner(match);
    }
  }
  saveState();
  renderAll();
  if (nextStatus === "live") {
    const liveInfo = getMatchLiveInfoFromState(roundIndex, matchIndex);
    if (canOpenMatchLive(liveInfo)) {
      if (isTournamentLiveShowingMatch(roundIndex, matchIndex)) {
        refreshOpenTournamentLiveScore(roundIndex, matchIndex);
      } else {
        window.openTournamentCameraTable?.(liveInfo.table, liveInfo);
      }
    }
  } else {
    refreshOpenTournamentLiveScore(roundIndex, matchIndex);
  }
}

function matchStatusControl(match, roundIndex, matchIndex) {
  if (!isAdmin) return `<span class="status">${matchStatusLabel(match.status)}</span>`;
  return `
    <select class="match-status-select status status-${escapeHtml(match.status || "pending")}" data-round="${roundIndex}" data-match="${matchIndex}" aria-label="Trạng thái trận ${matchIndex + 1}">
      <option value="pending"${match.status !== "live" && match.status !== "done" ? " selected" : ""}>Chưa đấu</option>
      <option value="live"${match.status === "live" ? " selected" : ""}>Đang đấu</option>
      <option value="done"${match.status === "done" ? " selected" : ""}>Kết thúc</option>
    </select>`;
}

function playerRow(name, score, winner, roundIndex, matchIndex, field, record = "") {
  const disabled = !name ? "disabled" : "";
  const scoreMarkup = isAdmin
    ? `<input class="score-input" ${disabled} data-round="${roundIndex}" data-match="${matchIndex}" data-field="${field}" value="${escapeHtml(score)}" inputmode="numeric" aria-label="Điểm ${escapeHtml(name || "")}" />`
    : `<span class="score score-display">${escapeHtml(score || "-")}</span>`;

  return `
    <div class="player ${winner ? "winner" : ""}">
      <span class="flag">★</span>
      <span class="avatar" aria-hidden="true"></span>
      <span class="name">${escapeHtml(name || "Chờ xác định")}</span>
      ${record ? `<span class="player-record">${escapeHtml(record)}</span>` : ""}
      ${scoreMarkup}
    </div>
  `;
}

function doubleBracketLayout() {
  const firstRoundSize = (state.rounds[0]?.matches.length || 1) * 2;
  const winnerCount = Math.log2(firstRoundSize);
  const loserCount = Math.max(0, winnerCount * 2 - 2);
  const stepX = cardWidth + gapX;
  const winnerHeight = Math.max(rowHeight * (state.rounds[0]?.matches.length || 1), cardHeight + 40);
  const loserTop = topOffset + winnerHeight + 170;
  const loserHeight = Math.max(rowHeight * Math.max(1, state.rounds[winnerCount]?.matches.length || 1), cardHeight + 40);
  const finalColumn = Math.max(winnerCount, loserCount) + 1;
  return { winnerCount, loserCount, stepX, winnerHeight, loserTop, loserHeight, finalColumn };
}

function diagramBracketLayout() {
  const winnerRoundCount = Math.floor((state.rounds.length - 1) / 2);
  const firstRoundMatches = state.rounds[0]?.matches.length || 1;
  const winnerHeight = firstRoundMatches * rowHeight;
  const loserTop = topOffset + winnerHeight + 170;
  const loserHeight = Math.max(1, state.rounds[winnerRoundCount]?.matches.length || 1) * rowHeight;
  return {
    winnerRoundCount,
    firstRoundMatches,
    stepX: cardWidth + 86,
    columns: winnerRoundCount + 1,
    winnerHeight,
    loserTop,
    loserHeight,
    height: loserTop + loserHeight + 110,
  };
}

function groupedBracketLayout() {
  const selectedRound = state.rounds[selectedBracketRoundIndex];
  const selectedGroupCount = isGroupedRound(selectedRound) ? Math.max(1, selectedRound.groups?.length || 1) : 2;
  const singleGroupFull = selectedGroupCount === 1;
  const groupedCardWidth = singleGroupFull ? 320 : 270;
  const baseGroupWidth = 270 * 2 + 120;
  const groupHeight = cardHeight * 3 + 258;
  const groupGapX = 76;
  const groupGapY = 86;
  const groupsPerRow = singleGroupFull ? 1 : 2;
  const roundGapX = 110;
  const roundWidth = baseGroupWidth * 2 + groupGapX;
  const groupWidth = singleGroupFull ? roundWidth : baseGroupWidth;
  const sideInset = singleGroupFull ? 42 : 24;
  return {
    groupWidth,
    groupHeight,
    groupGapX,
    groupGapY,
    groupsPerRow,
    roundGapX,
    roundWidth,
    roundStepX: roundWidth + roundGapX,
    top: topOffset + 64,
    cardWidth: groupedCardWidth,
    leftOpening: sideInset,
    leftFinal: singleGroupFull ? groupWidth - groupedCardWidth - sideInset : sideInset + groupedCardWidth + 72,
    roleY: {
      opening0: 82,
      opening1: 82 + cardHeight + 58,
      losers: 82 + (cardHeight + 58) * 2,
      winners: 82 + Math.round((cardHeight + 58) / 2),
      decider: 82 + cardHeight + 58 + Math.round((cardHeight + 58) / 2),
      final: 142,
    },
  };
}

function groupedGroupPosition(roundIndex, groupIndex) {
  const layout = groupedBracketLayout();
  const column = groupIndex % layout.groupsPerRow;
  const row = Math.floor(groupIndex / layout.groupsPerRow);
  return {
    x: (roundIndex - bracketRenderRoundOffset) * layout.roundStepX + column * (layout.groupWidth + layout.groupGapX),
    y: layout.top + row * (layout.groupHeight + layout.groupGapY),
  };
}

function matchPosition(roundIndex, matchIndex) {
  const round = state.rounds[roundIndex];
  if (round?.bracketGroup?.startsWith("diagram-")) {
    const layout = diagramBracketLayout();
    let column;
    let group;
    if (roundIndex < layout.winnerRoundCount) {
      column = roundIndex;
      group = layout.firstRoundMatches / Math.max(1, round.matches.length);
    } else if (roundIndex < layout.winnerRoundCount * 2) {
      const loserIndex = roundIndex - layout.winnerRoundCount;
      column = loserIndex;
      group = layout.firstRoundMatches / Math.max(1, round.matches.length);
    } else {
      column = layout.winnerRoundCount;
      group = layout.firstRoundMatches;
    }
    const localCenter = (matchIndex * group + group / 2) * rowHeight;
    let center = topOffset + localCenter;
    if (roundIndex >= layout.winnerRoundCount && roundIndex < layout.winnerRoundCount * 2) {
      center = layout.loserTop + localCenter;
    } else if (roundIndex === layout.winnerRoundCount * 2) {
      const winnerFinalCenter = topOffset + layout.winnerHeight / 2;
      const loserFinalCenter = layout.loserTop + layout.loserHeight / 2;
      center = (winnerFinalCenter + loserFinalCenter) / 2;
    }
    return {
      x: column * layout.stepX,
      y: center - cardHeight / 2,
      centerY: center,
    };
  }
  if (round?.bracketGroup === "record" || round?.bracketGroup === "record-final") {
    const center = topOffset + 70 + matchIndex * (cardHeight + 30) + cardHeight / 2;
    return { x: roundIndex * (cardWidth + gapX), y: center - cardHeight / 2, centerY: center };
  }
  if (round?.bracketGroup === "single-elimination") {
    const matchesPerRow = Math.max(1, Math.ceil((round.matches?.length || 1) / 2));
    const localRoundIndex = roundIndex - bracketRenderRoundOffset;
    const column = matchIndex % matchesPerRow;
    const row = Math.floor(matchIndex / matchesPerRow);
    const x = localRoundIndex * (cardWidth + gapX) + column * (cardWidth + 56);
    const y = topOffset + 92 + row * (cardHeight + 76);
    return { x, y, centerY: y + cardHeight / 2 };
  }
  if (isGroupedRound(round)) {
    const layout = groupedBracketLayout();
    const match = round.matches[matchIndex];
    const groupIndex = Number.isInteger(match?.groupIndex) ? match.groupIndex : 0;
    const groupPos = groupedGroupPosition(roundIndex, groupIndex);
    const groupMatches = (round.matches || []).filter((item) => item.groupIndex === groupIndex);
    const sameRoleIndex = groupMatches.filter((item) => item.groupRole === match?.groupRole).findIndex((item) => item === match);
    let x = groupPos.x + layout.leftOpening;
    let y = groupPos.y + layout.roleY.opening0;
    if (match?.groupRole === "opening") {
      x = groupPos.x + layout.leftOpening;
      y = groupPos.y + (sameRoleIndex <= 0 ? layout.roleY.opening0 : layout.roleY.opening1);
    } else if (match?.groupRole === "winners") {
      x = groupPos.x + layout.leftFinal;
      y = groupPos.y + layout.roleY.winners;
    } else if (match?.groupRole === "losers") {
      x = groupPos.x + layout.leftOpening;
      y = groupPos.y + layout.roleY.losers;
    } else if (match?.groupRole === "decider") {
      x = groupPos.x + layout.leftFinal;
      y = groupPos.y + layout.roleY.decider;
    } else if (match?.groupRole === "final") {
      x = groupPos.x + (layout.groupWidth - layout.cardWidth) / 2;
      y = groupPos.y + layout.roleY.final;
    }
    return { x, y, centerY: y + cardHeight / 2 };
  }
  if (round?.bracketGroup) {
    const layout = doubleBracketLayout();
    if (round.bracketGroup === "loser") {
      const localRound = roundIndex - layout.winnerCount;
      const group = 2 ** Math.floor((localRound + 1) / 2);
      const center = (matchIndex * group + group / 2) * rowHeight;
      return { x: localRound * layout.stepX, y: layout.loserTop + center - cardHeight / 2, centerY: layout.loserTop + center };
    }
    if (round.bracketGroup === "final") {
      const x = (layout.finalColumn + matchIndex) * layout.stepX;
      const center = topOffset + layout.winnerHeight / 2;
      return { x, y: center - cardHeight / 2, centerY: center };
    }
    const group = 2 ** roundIndex;
    const center = (matchIndex * group + group / 2) * rowHeight;
    return { x: roundIndex * layout.stepX, y: topOffset + center - cardHeight / 2, centerY: topOffset + center };
  }
  const group = 2 ** roundIndex;
  const center = (matchIndex * group + group / 2) * rowHeight;
  return {
    x: roundIndex * (cardWidth + gapX),
    y: topOffset + center - cardHeight / 2,
    centerY: topOffset + center,
  };
}

function line(className, x, y, width, height) {
  const el = document.createElement("span");
  el.className = `connector ${className}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(width, 1)}px`;
  el.style.height = `${Math.max(height, 1)}px`;
  return el;
}

function bracketConnector(canvas, className, from, to) {
  const startX = to.x >= from.x ? from.x + from.width : from.x;
  const startY = from.y + from.height / 2;
  const endX = to.x >= from.x ? to.x : to.x + to.width;
  const endY = to.y + to.height / 2;
  const midX = (startX + endX) / 2;
  canvas.append(line(className, Math.min(startX, midX), startY, Math.abs(midX - startX), 1));
  canvas.append(line(className, midX, Math.min(startY, endY), 1, Math.abs(endY - startY)));
  canvas.append(line(className, Math.min(midX, endX), endY, Math.abs(endX - midX), 1));
}

function renderGroupedBracketConnectors(canvas, round, roundIndex) {
  if (!isGroupedRound(round) || !Array.isArray(round.groups)) return;
  const layout = groupedBracketLayout();
  round.groups.forEach((group) => {
    const groupMatches = (round.matches || []).filter((match) => match.groupIndex === group.index);
    const openings = groupMatches.filter((match) => match.groupRole === "opening");
    const winnersMatch = groupMatches.find((match) => match.groupRole === "winners");
    const losersMatch = groupMatches.find((match) => match.groupRole === "losers");
    const deciderMatch = groupMatches.find((match) => match.groupRole === "decider");
    if (openings.length < 2 || !winnersMatch || !losersMatch || !deciderMatch) return;
    const rect = (match) => {
      const pos = matchPosition(roundIndex, match.matchIndex);
      return { x: pos.x, y: pos.y, width: layout.cardWidth, height: cardHeight };
    };
    bracketConnector(canvas, "grouped-flow win-path", rect(openings[0]), rect(winnersMatch));
    bracketConnector(canvas, "grouped-flow win-path", rect(openings[1]), rect(winnersMatch));
    bracketConnector(canvas, "grouped-flow drop-path", rect(openings[0]), rect(losersMatch));
    bracketConnector(canvas, "grouped-flow drop-path", rect(openings[1]), rect(losersMatch));
    bracketConnector(canvas, "grouped-flow drop-path", rect(winnersMatch), rect(deciderMatch));
    bracketConnector(canvas, "grouped-flow win-path", rect(losersMatch), rect(deciderMatch));
  });
}

function bracketRoundTabLabel(round, roundIndex) {
  const title = String(round?.title || `Vòng ${roundIndex + 1}`).replace(/^Nhánh (thắng|thua) • /i, "");
  return title || `Vòng ${roundIndex + 1}`;
}

function resetBracketScroll() {
  document.querySelector("#bracketCanvas")?.closest(".bracket-scroll")?.scrollTo({ left: 0, top: 0 });
}

function renderBracketRoundTabs() {
  const tabs = document.querySelector("#bracketRoundTabs");
  if (!tabs) return;
  if (!state.rounds.length) {
    tabs.innerHTML = "";
    return;
  }
  selectedBracketRoundIndex = Math.min(Math.max(0, selectedBracketRoundIndex), state.rounds.length - 1);
  tabs.innerHTML = state.rounds
    .map((round, roundIndex) => `
      <button class="round-tab${roundIndex === selectedBracketRoundIndex ? " active" : ""}" data-bracket-round-tab="${roundIndex}" type="button">
        ${escapeHtml(bracketRoundTabLabel(round, roundIndex))}
      </button>
    `)
    .join("");
  tabs.querySelectorAll("[data-bracket-round-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedBracketRoundIndex = Number(button.dataset.bracketRoundTab) || 0;
      renderBracket();
      resetBracketScroll();
    });
  });
}

function applyBracketScale() {
  const canvas = document.querySelector("#bracketCanvas");
  const scroll = canvas?.closest(".bracket-scroll");
  const button = scroll?.querySelector("[data-bracket-fit]");
  if (!canvas || !scroll) return;
  canvas.style.zoom = "1";
  if (!bracketFitMode) {
    canvas.style.zoom = String(bracketManualScale);
    scroll.classList.remove("is-fit");
    if (button) button.textContent = `Thu vừa màn hình • ${Math.round(bracketManualScale * 100)}%`;
    return;
  }
  const availableWidth = scroll.clientWidth - 8;
  if (availableWidth <= 0) return;
  const naturalWidth = Math.max(canvas.scrollWidth, Number.parseFloat(canvas.style.minWidth) || 1);
  const scale = Math.min(1, availableWidth / naturalWidth);
  canvas.style.zoom = String(scale);
  scroll.classList.add("is-fit");
  if (button) button.textContent = scale < 1 ? "Hiện 100%" : "Đã vừa màn hình";
}

function bindBracketFit() {
  document.querySelectorAll("[data-bracket-fit]").forEach((button) => {
    button.addEventListener("click", () => {
      if (bracketFitMode) {
        bracketFitMode = false;
        bracketManualScale = 1;
      } else {
        bracketFitMode = true;
      }
      applyBracketScale();
    });
  });
  document.querySelectorAll(".bracket-scroll").forEach((scroll) => {
    scroll.addEventListener("wheel", (event) => {
      const canvas = scroll.querySelector("#bracketCanvas");
      if (!canvas) return;
      event.preventDefault();
      const oldScale = Number.parseFloat(canvas.style.zoom) || 1;
      const direction = event.deltaY < 0 ? 1 : -1;
      const nextScale = Math.min(2.5, Math.max(0.25, oldScale + direction * 0.1));
      const rect = scroll.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const contentX = (scroll.scrollLeft + pointerX) / oldScale;
      const contentY = (scroll.scrollTop + pointerY) / oldScale;
      bracketFitMode = false;
      bracketManualScale = nextScale;
      applyBracketScale();
      scroll.scrollLeft = contentX * nextScale - pointerX;
      scroll.scrollTop = contentY * nextScale - pointerY;
    }, { passive: false });

    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let pinchContentX = 0;
    let pinchContentY = 0;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;
    let isTouchPanning = false;
    let isMousePanning = false;
    let mouseDidDrag = false;
    let mouseStartX = 0;
    let mouseStartY = 0;
    let mouseScrollLeft = 0;
    let mouseScrollTop = 0;
    const touchDistance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const touchCenter = (touches) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    });

    scroll.addEventListener("touchstart", (event) => {
      if (event.touches.length === 1) {
        panStartX = event.touches[0].clientX;
        panStartY = event.touches[0].clientY;
        panScrollLeft = scroll.scrollLeft;
        panScrollTop = scroll.scrollTop;
        isTouchPanning = false;
        return;
      }
      if (event.touches.length !== 2) return;
      const canvas = scroll.querySelector("#bracketCanvas");
      if (!canvas) return;
      event.preventDefault();
      const center = touchCenter(event.touches);
      const rect = scroll.getBoundingClientRect();
      const localX = center.x - rect.left;
      const localY = center.y - rect.top;
      pinchStartDistance = touchDistance(event.touches);
      pinchStartScale = Number.parseFloat(canvas.style.zoom) || 1;
      pinchContentX = (scroll.scrollLeft + localX) / pinchStartScale;
      pinchContentY = (scroll.scrollTop + localY) / pinchStartScale;
      bracketFitMode = false;
    }, { passive: false });

    scroll.addEventListener("touchmove", (event) => {
      if (event.touches.length === 1) {
        const deltaX = event.touches[0].clientX - panStartX;
        const deltaY = event.touches[0].clientY - panStartY;
        if (!isTouchPanning && Math.hypot(deltaX, deltaY) < 6) return;
        isTouchPanning = true;
        event.preventDefault();
        scroll.scrollLeft = panScrollLeft - deltaX;
        scroll.scrollTop = panScrollTop - deltaY;
        return;
      }
      if (event.touches.length !== 2 || !pinchStartDistance) return;
      event.preventDefault();
      const canvas = scroll.querySelector("#bracketCanvas");
      const button = scroll.querySelector("[data-bracket-fit]");
      if (!canvas) return;
      const center = touchCenter(event.touches);
      const rect = scroll.getBoundingClientRect();
      const localX = center.x - rect.left;
      const localY = center.y - rect.top;
      const nextScale = Math.min(2.5, Math.max(0.25, pinchStartScale * touchDistance(event.touches) / pinchStartDistance));
      bracketManualScale = nextScale;
      canvas.style.zoom = String(nextScale);
      scroll.classList.remove("is-fit");
      scroll.scrollLeft = pinchContentX * nextScale - localX;
      scroll.scrollTop = pinchContentY * nextScale - localY;
      if (button) button.textContent = `Thu vừa màn hình • ${Math.round(nextScale * 100)}%`;
    }, { passive: false });

    scroll.addEventListener("touchend", (event) => {
      if (event.touches.length < 2) pinchStartDistance = 0;
      if (!event.touches.length) isTouchPanning = false;
    });

    scroll.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target.closest("input, button, select, textarea, a")) return;
      isMousePanning = true;
      mouseDidDrag = false;
      mouseStartX = event.clientX;
      mouseStartY = event.clientY;
      mouseScrollLeft = scroll.scrollLeft;
      mouseScrollTop = scroll.scrollTop;
      scroll.classList.add("is-dragging");
    });

    document.addEventListener("mousemove", (event) => {
      if (!isMousePanning) return;
      const deltaX = event.clientX - mouseStartX;
      const deltaY = event.clientY - mouseStartY;
      if (!mouseDidDrag && Math.hypot(deltaX, deltaY) < 5) return;
      mouseDidDrag = true;
      event.preventDefault();
      scroll.dataset.didDrag = "true";
      scroll.scrollLeft = mouseScrollLeft - deltaX;
      scroll.scrollTop = mouseScrollTop - deltaY;
    });

    document.addEventListener("mouseup", () => {
      if (!isMousePanning) return;
      isMousePanning = false;
      scroll.classList.remove("is-dragging");
      setTimeout(() => {
        delete scroll.dataset.didDrag;
      }, 0);
    });
  });
  if (typeof ResizeObserver !== "undefined") {
    bracketResizeObserver = new ResizeObserver(() => {
      if (bracketFitMode) requestAnimationFrame(applyBracketScale);
    });
    document.querySelectorAll(".bracket-scroll").forEach((scroll) => bracketResizeObserver.observe(scroll));
  }
  window.addEventListener("resize", applyBracketScale);
}

function bindDetailTreeNavigation(scroll, canvas) {
  if (!scroll || !canvas || scroll.dataset.navigationBound === "true") return;
  scroll.dataset.navigationBound = "true";
  const fitButton = scroll.querySelector("[data-detail-bracket-fit]");
  let scale = Number.parseFloat(canvas.style.zoom) || 1;
  let dragging = false;
  let dragged = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const updateLabel = () => {
    if (fitButton) fitButton.textContent = `Thu vừa màn hình • ${Math.round(scale * 100)}%`;
  };
  const zoomAt = (nextScale, clientX, clientY) => {
    const oldScale = scale;
    scale = Math.min(2.5, Math.max(0.25, nextScale));
    const rect = scroll.getBoundingClientRect();
    const pointerX = clientX - rect.left;
    const pointerY = clientY - rect.top;
    const contentX = (scroll.scrollLeft + pointerX) / oldScale;
    const contentY = (scroll.scrollTop + pointerY) / oldScale;
    canvas.style.zoom = String(scale);
    scroll.scrollLeft = contentX * scale - pointerX;
    scroll.scrollTop = contentY * scale - pointerY;
    updateLabel();
  };

  fitButton?.addEventListener("click", () => {
    canvas.style.zoom = "1";
    const naturalWidth = Math.max(canvas.scrollWidth, Number.parseFloat(canvas.style.minWidth) || 1);
    scale = Math.min(1, Math.max(0.25, (scroll.clientWidth - 8) / naturalWidth));
    canvas.style.zoom = String(scale);
    scroll.scrollTo({ left: 0, top: 0 });
    updateLabel();
  });
  scroll.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(scale + (event.deltaY < 0 ? 0.1 : -0.1), event.clientX, event.clientY);
  }, { passive: false });
  scroll.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("input, button, select, textarea, a")) return;
    dragging = true;
    dragged = false;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = scroll.scrollLeft;
    startTop = scroll.scrollTop;
    scroll.setPointerCapture?.(event.pointerId);
    scroll.classList.add("is-dragging");
  });
  scroll.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (!dragged && Math.hypot(deltaX, deltaY) < 5) return;
    dragged = true;
    scroll.dataset.didDrag = "true";
    scroll.scrollLeft = startLeft - deltaX;
    scroll.scrollTop = startTop - deltaY;
  });
  const stopDragging = (event) => {
    if (!dragging) return;
    dragging = false;
    scroll.releasePointerCapture?.(event.pointerId);
    scroll.classList.remove("is-dragging");
    setTimeout(() => delete scroll.dataset.didDrag, 0);
  };
  scroll.addEventListener("pointerup", stopDragging);
  scroll.addEventListener("pointercancel", stopDragging);
  updateLabel();
}

function renderBracket() {
  const canvas = document.querySelector("#bracketCanvas");
  const title = document.querySelector("#bracketTitle");
  if (!canvas) {
    return;
  }

  renderBracketRoundTabs();
  canvas.innerHTML = "";
  canvas.style.zoom = "1";
  if (title) {
    title.textContent = state.tournament.name || "Ma Buu Billiards Tournament";
  }
  document.documentElement.style.setProperty("--card-h", `${cardHeight}px`);
  document.documentElement.style.setProperty("--row-h", `${rowHeight}px`);

  if (!state.rounds.length) {
    const empty = document.createElement("div");
    empty.className = "raw-bracket-note";
    empty.textContent = isAdmin
      ? "Chưa có bracket. Vào tab Cơ thủ để thêm người và tạo sơ đồ."
      : "Chưa có dữ liệu giải đấu. Vui lòng quay lại sau.";
    canvas.append(empty);
    return;
  }

  const isDoubleBracket = state.rounds.some((round) => round.bracketGroup === "winner" || round.bracketGroup === "loser" || round.bracketGroup === "final");
  const isRecordBracket = state.rounds.some((round) => round.bracketGroup === "record" || round.bracketGroup === "record-final");
  const isDiagramBracket = state.rounds.some((round) => round.bracketGroup?.startsWith("diagram-"));
  const isGroupedBracket = state.rounds.some((round) => isGroupedRound(round));
  const selectedVisibleRound = state.rounds[selectedBracketRoundIndex];
  const isSingleEliminationView = isGroupedBracket && selectedVisibleRound?.bracketGroup === "single-elimination";
  const layout = isDoubleBracket ? doubleBracketLayout() : null;
  const diagramLayout = isDiagramBracket ? diagramBracketLayout() : null;
  const groupedLayout = isGroupedBracket ? groupedBracketLayout() : null;
  const visibleRoundIndices = isGroupedBracket ? [selectedBracketRoundIndex] : state.rounds.map((_, index) => index);
  bracketRenderRoundOffset = isGroupedBracket ? selectedBracketRoundIndex : 0;
  canvas.classList.toggle("double-bracket", isDoubleBracket);
  canvas.classList.toggle("record-bracket", isRecordBracket);
  canvas.classList.toggle("diagram-bracket", isDiagramBracket);
  canvas.classList.toggle("grouped-bracket", isGroupedBracket && isGroupedRound(selectedVisibleRound));
  canvas.classList.toggle("single-elimination-bracket", isSingleEliminationView);
  const singleMatchesPerRow = isSingleEliminationView ? Math.max(1, Math.ceil((selectedVisibleRound.matches?.length || 1) / 2)) : 0;
  canvas.style.minWidth = isDiagramBracket
    ? `${diagramLayout.columns * diagramLayout.stepX + cardWidth}px`
    : isDoubleBracket
    ? `${(layout.finalColumn + 2) * layout.stepX + cardWidth}px`
    : isSingleEliminationView
    ? `${singleMatchesPerRow * cardWidth + Math.max(0, singleMatchesPerRow - 1) * 56}px`
    : isGroupedBracket
    ? `${groupedLayout.roundWidth}px`
    : `${state.rounds.length * cardWidth + (state.rounds.length - 1) * gapX}px`;
  const doubleHeight = isDoubleBracket ? layout.loserTop + layout.loserHeight + 110 : 0;
  const recordHeight = isRecordBracket
    ? topOffset + Math.max(...state.rounds.map((round) => round.matches.length)) * (cardHeight + 30) + 70
    : 0;
  const groupedHeight = isGroupedBracket
    ? groupedLayout.top + Math.max(...visibleRoundIndices.map((roundIndex) => Math.ceil(Math.max(1, state.rounds[roundIndex]?.groups?.length || 1) / groupedLayout.groupsPerRow))) * (groupedLayout.groupHeight + groupedLayout.groupGapY) + 24
    : 0;
  const singleEliminationHeight = isSingleEliminationView ? topOffset + 92 + Math.min(2, selectedVisibleRound.matches?.length || 1) * (cardHeight + 76) + 32 : 0;
  canvas.style.height = `${Math.max(540, doubleHeight, recordHeight, groupedHeight, singleEliminationHeight, diagramLayout?.height || 0, topOffset + rowHeight * state.rounds[0].matches.length + 90)}px`;

  if (isDoubleBracket) {
    const winnerZone = document.createElement("div");
    winnerZone.className = "bracket-zone winner-zone";
    winnerZone.style.height = `${layout.winnerHeight + 100}px`;
    winnerZone.innerHTML = `<strong>NHÁNH THẮNG</strong><span>Thắng tiếp tục đi ở hàng trên</span>`;
    canvas.append(winnerZone);

    const loserZone = document.createElement("div");
    loserZone.className = "bracket-zone loser-zone";
    loserZone.style.top = `${layout.loserTop - 65}px`;
    loserZone.style.height = `${layout.loserHeight + 105}px`;
    loserZone.innerHTML = `<strong>NHÁNH THUA</strong><span>Thua lần hai sẽ bị loại</span>`;
    canvas.append(loserZone);

    const legend = document.createElement("div");
    legend.className = "bracket-flow-legend";
    legend.style.top = `${layout.loserTop - 112}px`;
    legend.innerHTML = `<span><i class="flow-win"></i> Đường đi khi thắng</span><span><i class="flow-drop"></i> Thua lần đầu xuống nhánh dưới</span>`;
    canvas.append(legend);
  }
  if (isRecordBracket) {
    const recordGuide = document.createElement("div");
    recordGuide.className = "record-bracket-guide";
    recordGuide.innerHTML = `<strong>BỐC CẶP NGẪU NHIÊN • 2 MẠNG</strong><span>Mỗi vòng bốc lại trong số người còn sống. Thua đủ 2 trận bị loại; còn 2 người sẽ đấu chung kết.</span>`;
    canvas.append(recordGuide);
  }
  if (isGroupedBracket) {
    visibleRoundIndices.forEach((roundIndex) => {
      const round = state.rounds[roundIndex];
      if (!isGroupedRound(round) || !Array.isArray(round.groups) || !round.groups.length) return;
      round.groups.forEach((group) => {
        const groupMatches = (round.matches || []).filter((match) => match.groupIndex === group.index);
        if (!groupMatches.length) return;
        const groupPos = groupedGroupPosition(roundIndex, group.index);
        const frame = document.createElement("div");
        frame.className = "grouped-bracket-frame";
        frame.style.left = `${groupPos.x}px`;
        frame.style.top = `${groupPos.y}px`;
        frame.style.width = `${groupedLayout.groupWidth}px`;
        frame.style.height = `${groupedLayout.groupHeight}px`;
        frame.innerHTML = `<strong>${escapeHtml(group.label)}</strong>`;
        canvas.append(frame);
      });
    });
  }

  visibleRoundIndices.forEach((roundIndex) => {
    const round = state.rounds[roundIndex];
    const roundTitle = document.createElement("div");
    roundTitle.className = "round-title";
    roundTitle.textContent = round.title.replace(/^Nhánh (thắng|thua) • /i, "");
    const titlePos = matchPosition(roundIndex, 0);
    roundTitle.style.left = `${titlePos.x}px`;
    if (round.bracketGroup === "loser") roundTitle.style.top = `${layout.loserTop - 30}px`;
    if (round.bracketGroup === "final") roundTitle.style.top = "18px";
    if (round.bracketGroup === "record" || round.bracketGroup === "record-final") roundTitle.style.top = "54px";
    if (isGroupedRound(round)) {
      roundTitle.style.left = "0px";
      roundTitle.style.top = "54px";
      roundTitle.style.width = `${groupedLayout.roundWidth}px`;
    }
    if (round.bracketGroup === "diagram-loser") roundTitle.style.top = `${diagramLayout.loserTop - 42}px`;
    if (round.bracketGroup === "diagram-grand") roundTitle.style.top = `${titlePos.y - 48}px`;
    canvas.append(roundTitle);

    if (isGroupedRound(round)) {
      renderGroupedBracketConnectors(canvas, round, roundIndex);
    }

    round.matches.forEach((match, matchIndex) => {
      const pos = matchPosition(roundIndex, matchIndex);
      const isLiveMatch = match.playerA && match.playerB && match.status === "live";
      const el = document.createElement("article");
      el.className = `match${round.bracketGroup ? ` bracket-${round.bracketGroup}` : ""}`;
      el.dataset.openMatchCamera = Number(match.table) || matchIndex + 1;
      el.dataset.matchLabel = `Tran ${match.matchIndex + 1}`;
      el.dataset.matchLive = isLiveMatch ? "true" : "false";
      el.dataset.matchStatus = match.status || "pending";
      el.dataset.round = roundIndex;
      el.dataset.match = matchIndex;
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      if (isGroupedRound(round)) {
        el.style.width = `${groupedLayout.cardWidth}px`;
      }
      el.innerHTML = `
        <div class="match-meta">
          <span>${match.groupLabel ? `${escapeHtml(match.groupLabel)} • ` : ""}${match.groupMatchLabel ? `${escapeHtml(match.groupMatchLabel)} • ` : ""}${match.time || `Bàn ${String(match.table).padStart(2, "0")}`}</span>
          <button class="match-camera" data-open-match-camera="${Number(match.table) || matchIndex + 1}" type="button" ${isLiveMatch ? "" : "disabled"} title="${isLiveMatch ? "Mo camera EZVIZ" : "Chi mo camera khi tran dang dien ra"}">EZVIZ</button>
          ${matchStatusControl(match, roundIndex, matchIndex)}
        </div>
        <div class="match-body">
          ${playerRow(match.playerA, match.scoreA, match.winner === match.playerA, roundIndex, matchIndex, "scoreA", match.recordA)}
          ${playerRow(match.playerB, match.scoreB, match.winner === match.playerB, roundIndex, matchIndex, "scoreB", match.recordB)}
        </div>
      `;
      canvas.append(el);

      const winRoute = match.nextWin || (!round.bracketGroup && roundIndex < state.rounds.length - 1
        ? { round: roundIndex + 1, match: Math.floor(matchIndex / 2) }
        : null);
      if (winRoute) {
        const next = matchPosition(winRoute.round, winRoute.match);
        const startX = pos.x + cardWidth;
        const midX = startX + gapX / 2;
        const endX = next.x;
        const y1 = pos.centerY;
        const y2 = next.centerY;

        if (endX > startX) {
          canvas.append(line("horizontal win-path", startX, y1, midX - startX, 1));
          canvas.append(line("vertical win-path", midX, Math.min(y1, y2), 1, Math.abs(y2 - y1)));
          canvas.append(line("horizontal win-path", midX, y2, endX - midX, 1));
        } else if (next.x + cardWidth < pos.x) {
          const reverseStart = pos.x;
          const reverseEnd = next.x + cardWidth;
          const reverseMid = reverseStart - gapX / 2;
          canvas.append(line("horizontal win-path", reverseMid, y1, reverseStart - reverseMid, 1));
          canvas.append(line("vertical win-path", reverseMid, Math.min(y1, y2), 1, Math.abs(y2 - y1)));
          canvas.append(line("horizontal win-path", reverseEnd, y2, reverseMid - reverseEnd, 1));
        }
      }
    });
  });

  canvas.querySelectorAll(".match[data-open-match-camera]").forEach((matchCard) => {
    matchCard.addEventListener("click", (event) => {
      if (matchCard.closest(".bracket-scroll")?.dataset.didDrag === "true") return;
      if (event.target.closest("input, button, select, textarea")) {
        return;
      }
      if (isAdmin) {
        openMatchPairEditor(Number(matchCard.dataset.round), Number(matchCard.dataset.match));
        return;
      }
      const matchInfo = getMatchLiveInfo(matchCard);
      if (!canOpenMatchLive(matchInfo)) {
        return;
      }
      window.openTournamentCameraTable?.(matchCard.dataset.openMatchCamera, matchInfo);
    });
  });

  canvas.querySelectorAll(".match-camera").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const matchCard = button.closest(".match");
      window.openTournamentCameraTable?.(button.dataset.openMatchCamera, getMatchLiveInfo(matchCard));
    });
  });

  requestAnimationFrame(applyBracketScale);

  if (!isAdmin) {
    return;
  }

  canvas.querySelectorAll(".score-input").forEach((input) => {
    input.addEventListener("change", () => {
      updateMatchScore(Number(input.dataset.round), Number(input.dataset.match), input.dataset.field, input.value.trim());
    });
  });
  canvas.querySelectorAll(".match-status-select").forEach((select) => {
    select.addEventListener("change", () => {
      updateMatchStatus(Number(select.dataset.round), Number(select.dataset.match), select.value);
    });
  });
}

function bindTabs() {
  const buttons = document.querySelectorAll(".tab, .nav-submenu button, .camera-view-button");
  const topTabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  const activate = (tabName, options = {}) => {
    if (tabName === "camera") {
      selectedCameraView = options.cameraView || "lan";
    }
    topTabs.forEach((button) => button.classList.toggle("active", button.dataset.tab === tabName));
    document.querySelectorAll(".tournament-quick-nav [data-home-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.homeTab === tabName);
    });
    const tournamentTabs = new Set(["home", "schedule", "tournamentRanking", "bracket"]);
    document.querySelectorAll(".page-home-only").forEach((element) => {
      element.hidden = !tournamentTabs.has(tabName);
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== tabName;
    });
    document.querySelector("[data-camera-menu]")?.classList.remove("open");
    if (tabName === "bracket") {
      requestAnimationFrame(() => requestAnimationFrame(applyBracketScale));
    }
    if (isAdmin && tabName === "requests") {
      loadRegistrationRequests().then(renderAll);
    }
    if (tabName === "tournaments") {
      renderTournamentDirectory();
    }
    if (tabName === "camera") {
      renderCameraViewPanels();
    }
    if (options.focusTournamentName) {
      document.querySelector("#tournamentName")?.focus();
    }
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const cameraMenu = document.querySelector("[data-camera-menu]");
      if (button.parentElement?.matches("[data-camera-menu]")) {
        cameraMenu?.classList.toggle("open");
        return;
      }
      activate(button.dataset.tab, { cameraView: button.dataset.cameraView });
    });
  });

  const cameraMenu = document.querySelector("[data-camera-menu]");
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("[data-camera-menu]")) {
      cameraMenu?.classList.remove("open");
    }
  });

  document.querySelectorAll("[data-home-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.homeDetail) {
        selectedTournamentId = "current";
        selectedTournamentDetailTab = button.dataset.homeDetail;
        selectedDetailRoundIndex = 0;
      }
      activate(button.dataset.homeTab);
    });
  });

  document.querySelector("#quickCreateTournament")?.addEventListener("click", () => {
    if (isAdmin) {
      openCreateTournamentModal();
      return;
    }
    activate("tournaments");
  });
  document.querySelector("[data-open-create-tournament]")?.addEventListener("click", openCreateTournamentModal);
}

function keepActivePanelVisible() {
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  if (!activeTab) {
    return;
  }

  document.querySelectorAll(".panel").forEach((panel) => {
    panel.hidden = panel.id !== activeTab;
  });
}

const DEFAULT_MINI_GAME_PRIZES = ["Giảm 10%", "Nước miễn phí", "Tặng 1 giờ bàn", "Chúc may mắn", "Giảm 20%", "Áo Ma Buu", "Voucher 50K", "Quay lại"];
const MINI_GAME_PRIZES_KEY = "maBuuMiniGamePrizes";
const MINI_GAME_HISTORY_KEY = "maBuuMiniGameHistory";
let miniGameRotation = 0;
let miniGameSpinning = false;

function getMiniGamePrizes() {
  try {
    const saved = JSON.parse(localStorage.getItem(MINI_GAME_PRIZES_KEY) || "[]");
    if (Array.isArray(saved)) {
      const prizes = saved.map((item) => String(item || "").trim()).filter(Boolean);
      if (prizes.length >= 2) {
        return prizes;
      }
    }
  } catch (error) {
    // Ignore broken local storage and fall back to defaults.
  }

  return [...DEFAULT_MINI_GAME_PRIZES];
}

function saveMiniGamePrizes(prizes) {
  localStorage.setItem(MINI_GAME_PRIZES_KEY, JSON.stringify(prizes));
}

function getMiniGameHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(MINI_GAME_HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(0, 8) : [];
  } catch (error) {
    return [];
  }
}

function saveMiniGameHistory(history) {
  localStorage.setItem(MINI_GAME_HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
}

function renderMiniGameHistory() {
  const historyNode = document.querySelector("#prizeHistory");
  const history = getMiniGameHistory();

  if (!historyNode) {
    return;
  }

  if (!history.length) {
    historyNode.textContent = "Chưa có lượt quay.";
    return;
  }

  historyNode.innerHTML = history
    .map((item) => `<span>${escapeHtml(item.prize)} <small>${escapeHtml(item.time)}</small></span>`)
    .join("");
}

function renderMiniGameWheel() {
  const wheel = document.querySelector("#prizeWheel");
  const labels = document.querySelector("#wheelLabels");
  const input = document.querySelector("#prizeListInput");

  if (!wheel || !labels || !input) {
    return;
  }

  const prizes = getMiniGamePrizes();
  const step = 360 / prizes.length;
  const colors = ["#48d6c6", "#f05bbf", "#f6c85f", "#6c8cff", "#ff6b6b", "#7fd56f", "#d978ff", "#5bc0f0"];
  const slices = prizes.map((_, index) => {
    const start = index * step;
    const end = (index + 1) * step;
    return `${colors[index % colors.length]} ${start}deg ${end}deg`;
  });

  input.value = prizes.join("\n");
  wheel.style.background = `conic-gradient(from -90deg, ${slices.join(", ")})`;
  wheel.style.setProperty("--wheel-rotation", `${miniGameRotation}deg`);
  labels.innerHTML = prizes
    .map((prize, index) => {
      const rotation = index * step + step / 2;
      return `<span style="transform: rotate(${rotation}deg) translateY(-45%)"><b>${escapeHtml(prize)}</b></span>`;
    })
    .join("");
  renderMiniGameHistory();
}

function bindMiniGame() {
  const wheel = document.querySelector("#prizeWheel");
  const input = document.querySelector("#prizeListInput");
  const spinButton = document.querySelector("#spinPrizeWheel");
  const saveButton = document.querySelector("#savePrizeList");
  const resetButton = document.querySelector("#resetPrizeList");
  const result = document.querySelector("#miniGameResult");

  if (!wheel || !input || !spinButton || !saveButton || !resetButton || !result) {
    return;
  }

  const readInputPrizes = () => input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

  saveButton.addEventListener("click", () => {
    const prizes = readInputPrizes();

    if (prizes.length < 2) {
      result.textContent = "Cần ít nhất 2 ô phần thưởng để quay.";
      return;
    }

    saveMiniGamePrizes(prizes);
    renderMiniGameWheel();
    result.textContent = "Đã lưu danh sách phần thưởng.";
  });

  resetButton.addEventListener("click", () => {
    saveMiniGamePrizes(DEFAULT_MINI_GAME_PRIZES);
    saveMiniGameHistory([]);
    miniGameRotation = 0;
    renderMiniGameWheel();
    result.textContent = "Đã nạp lại mẫu mặc định.";
  });

  spinButton.addEventListener("click", () => {
    if (miniGameSpinning) {
      return;
    }

    const prizes = readInputPrizes();

    if (prizes.length < 2) {
      result.textContent = "Cần ít nhất 2 ô phần thưởng để quay.";
      return;
    }

    saveMiniGamePrizes(prizes);
    renderMiniGameWheel();

    const step = 360 / prizes.length;
    const winnerIndex = Math.floor(Math.random() * prizes.length);
    const targetCenter = winnerIndex * step + step / 2;
    const extraTurns = 5 + Math.floor(Math.random() * 3);
    miniGameRotation += extraTurns * 360 + (360 - targetCenter);
    miniGameSpinning = true;
    spinButton.disabled = true;
    result.textContent = "Đang quay...";
    wheel.style.setProperty("--wheel-rotation", `${miniGameRotation}deg`);

    window.setTimeout(() => {
      const prize = prizes[winnerIndex];
      const history = getMiniGameHistory();
      const time = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      history.unshift({ prize, time });
      saveMiniGameHistory(history);
      renderMiniGameHistory();
      result.textContent = `Trúng: ${prize}`;
      miniGameSpinning = false;
      spinButton.disabled = false;
    }, 4300);
  });

  renderMiniGameWheel();
}

function getCurrentTournamentEntry() {
  return {
    id: "current",
    savedAt: new Date().toISOString(),
    tournament: state.tournament,
    players: state.players,
    rounds: state.rounds,
    isCurrent: true,
  };
}

function getTournamentEntries() {
  return [getCurrentTournamentEntry(), ...state.tournamentHistory.map((entry) => ({ ...entry, isCurrent: false }))];
}

function matchesForEntry(entry) {
  return (entry.rounds || []).flatMap((round) => (round.matches || []).map((match) => ({ ...match, roundTitle: round.title })));
}

function hasCurrentTournamentContent() {
  const defaults = createDefaultState().tournament;
  return Boolean(
    state.players.length ||
      state.rounds.length ||
      state.tournament?.name !== defaults.name ||
      state.tournament?.date !== defaults.date ||
      state.tournament?.format !== defaults.format,
  );
}

function renderDetailInfo(entry) {
  const tournament = entry.tournament || {};
  const players = Array.isArray(entry.players) ? entry.players : [];
  const matches = matchesForEntry(entry);
  const doneMatches = matches.filter((match) => match.status === "done").length;

  if (isAdmin) {
    return `
      <div class="manager-grid registration-grid">
        <form class="form-section" id="directoryTournamentForm">
          <p>THÔNG TIN GIẢI</p>
          <h2>Sửa thông tin giải đấu</h2>
          <label>
            Tên giải
            <input name="name" type="text" value="${escapeHtml(tournament.name || "")}" placeholder="Ma Buu Billiards Tournament" required />
          </label>
          <label>
            Ngày thi đấu
            <input name="date" type="date" value="${escapeHtml(tournament.date || "")}" />
          </label>
          <label>
            Hạng giải
            <input name="rank" type="text" value="${escapeHtml(tournament.rank || "")}" placeholder="Ví dụ: G, H hoặc Mở rộng" />
          </label>
          <label>
            Đơn vị tổ chức
            <input name="organizer" type="text" value="${escapeHtml(tournament.organizer || "")}" placeholder="Ma Buu Billiards" />
          </label>
          <label>
            Địa điểm tổ chức
            <input name="location" type="text" value="${escapeHtml(tournament.location || "")}" placeholder="Tên CLB hoặc địa chỉ thi đấu" />
          </label>
          <label>
            Thông tin khác
            <textarea name="description" rows="5" placeholder="Nhập giới thiệu, điều lệ hoặc ghi chú của giải...">${escapeHtml(tournament.description || "")}</textarea>
          </label>
          <button class="primary-action" type="submit">Lưu thông tin</button>
        </form>
        <div class="info-grid compact-info detail-info">
          <article><small>Cơ thủ</small><strong>${players.length}</strong></article>
          <article><small>Trận đã xong</small><strong>${doneMatches}/${matches.length || 0}</strong></article>
          <article><small>Trạng thái</small><strong>${matches.length && doneMatches === matches.length ? "Hoàn tất" : "Đang diễn ra"}</strong></article>
        </div>
      </div>
    `;
  }

  return `
    <div class="info-grid compact-info detail-info">
      <article><small>Tên giải</small><strong>${escapeHtml(tournament.name || "Chưa thiết lập")}</strong></article>
      <article><small>Ngày thi đấu</small><strong>${escapeHtml(tournament.date || "Chưa chọn")}</strong></article>
      <article><small>Cơ thủ</small><strong>${players.length}</strong></article>
      <article><small>Trận đã xong</small><strong>${doneMatches}/${matches.length || 0}</strong></article>
      <article><small>Trạng thái</small><strong>${matches.length && doneMatches === matches.length ? "Hoàn tất" : "Đang diễn ra"}</strong></article>
    </div>
  `;
}

function renderDetailRegistration(entry) {
  if (isAdmin) {
    return renderDetailPlayersAdmin(entry);
  }

  if (!entry.isCurrent) {
    return `<div class="empty-state">Giải đã lưu chỉ dùng để xem lại lịch sử đấu.</div>`;
  }

  return `
    <div class="manager-grid registration-grid">
      <form class="form-section" id="directoryRegistrationForm">
        <p>ĐĂNG KÝ ĐẤU GIẢI</p>
        <h2>Gửi thông tin cho admin duyệt</h2>
        <label>
          Tên cơ thủ
          <input name="name" type="text" placeholder="Nhập họ tên" autocomplete="name" required />
        </label>
        <label>
          Hạng
          <select name="rank" required>
            <option>K</option><option>I</option><option>H</option><option>G</option><option>F</option><option>E</option><option>D</option><option>C</option><option>B</option><option>A</option>
          </select>
        </label>
        <label>
          Số điện thoại
          <input name="phone" type="tel" placeholder="Số liên hệ" autocomplete="tel" required />
        </label>
        <label>
          CLB / ghi chú
          <input name="note" type="text" placeholder="Tùy chọn" autocomplete="off" />
        </label>
        <button class="primary-action" type="submit">Gửi yêu cầu</button>
        <div class="form-status" id="directoryRegistrationStatus">Admin sẽ duyệt trước khi tên xuất hiện trong danh sách thi đấu.</div>
      </form>
      <div class="data-section registration-summary">
        <div class="section-heading">
          <div>
            <p>GIẢI ĐANG MỞ</p>
            <h2>${escapeHtml(state.tournament.name || "Ma Buu Billiards Tournament")}</h2>
          </div>
        </div>
        <div class="registration-facts">
          <article><small>Ngày thi đấu</small><strong>${escapeHtml(state.tournament.date || "Chưa chọn")}</strong></article>
          <article><small>Đã duyệt</small><strong>${state.players.length} cơ thủ</strong></article>
          <article><small>Trạng thái</small><strong>Đang nhận đăng ký</strong></article>
        </div>
      </div>
    </div>
  `;
}

function renderDetailPlayersAdmin(entry) {
  if (!entry.isCurrent) {
    const players = Array.isArray(entry.players) ? entry.players : [];
    return `
      <div class="history-block">
        <h3>Cơ thủ của giải đã lưu</h3>
        <div class="history-player-grid">
          ${players.length ? players.map((player, playerIndex) => `<span>${playerIndex + 1}. ${escapeHtml(player.name)}</span>`).join("") : `<span>Chưa có cơ thủ</span>`}
        </div>
      </div>
    `;
  }

  return `
    <div class="manager-grid">
      <form class="form-section" id="directoryPlayerForm">
        <p>DANH SÁCH</p>
        <h2>Thêm cơ thủ</h2>
        <label>
          Tên cơ thủ
          <input name="name" type="text" placeholder="Nhập tên cơ thủ" autocomplete="off" required />
        </label>
        <label>
          Hạng
          <select name="rank" required>
            <option>K</option><option>I</option><option>H</option><option>G</option><option>F</option><option>E</option><option>D</option><option>C</option><option>B</option><option>A</option>
          </select>
        </label>
        <label>
          Ghi chú / CLB
          <input name="note" type="text" placeholder="Tùy chọn" autocomplete="off" />
        </label>
        <button class="primary-action" type="submit">Thêm cơ thủ</button>
      </form>
      <div class="data-section">
        <div class="section-heading">
          <div>
            <p>ĐÃ ĐĂNG KÝ</p>
            <h2>${state.players.length} cơ thủ</h2>
          </div>
        </div>
        <div class="player-list">
          ${
            state.players.length
              ? state.players
                  .map(
                    (player, index) => `
                      <article class="player-item">
                        <div>
                          <strong>${index + 1}. ${escapeHtml(player.name)}</strong>
                          <span>${escapeHtml(player.note || "Chưa có ghi chú")}</span>
                        </div>
                        <button class="icon-action" data-directory-remove-player="${player.id}" type="button" aria-label="Xóa ${escapeHtml(player.name)}">×</button>
                      </article>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">Chưa có cơ thủ. Thêm cơ thủ để bắt đầu.</div>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderDetailRequestsAdmin(entry) {
  if (!entry.isCurrent) {
    return `<div class="empty-state">Yêu cầu chỉ áp dụng cho giải đang mở.</div>`;
  }

  const pendingRequests = state.registrationRequests.filter((request) => request.status === "pending");

  return `
    <div class="data-section wide-section inline-section">
      <div class="section-heading">
        <div>
          <p>DUYỆT ĐĂNG KÝ</p>
          <h2>${pendingRequests.length} yêu cầu chờ duyệt</h2>
        </div>
      </div>
      <div class="request-list">
        ${
          pendingRequests.length
            ? pendingRequests
                .map(
                  (request) => `
                    <article class="request-item">
                      <div>
                        <strong>${escapeHtml(request.name)}</strong>
                        <span>${escapeHtml(request.phone || "Chưa có số điện thoại")}</span>
                        <small>${escapeHtml(request.note || "Không có ghi chú")} • ${escapeHtml(new Date(request.createdAt).toLocaleString("vi-VN"))}</small>
                      </div>
                      <div class="request-actions">
                        <button class="primary-action" data-directory-approve-request="${request.id}" type="button">Duyệt</button>
                        <button class="danger-action" data-directory-reject-request="${request.id}" type="button">Từ chối</button>
                      </div>
                    </article>
                  `,
                )
                .join("")
            : `<div class="empty-state">Chưa có yêu cầu đăng ký mới.</div>`
        }
      </div>
    </div>
  `;
}

function renderDetailHistory(entry) {
  const matches = matchesForEntry(entry);

  return `
    <div class="history-match-list detail-match-list">
      ${
        matches.length
          ? matches
              .map(
                (match) => `
                  <article>
                    <strong>${escapeHtml(match.roundTitle)} - Trận ${match.matchIndex + 1}</strong>
                    <span>${escapeHtml(match.playerA || "TBD")} vs ${escapeHtml(match.playerB || "TBD")}</span>
                    <small>Bàn ${String(match.table).padStart(2, "0")} • ${escapeHtml(match.scoreA || "-")} - ${escapeHtml(match.scoreB || "-")} • ${matchStatusLabel(match.status)}</small>
                  </article>
                `,
              )
              .join("")
          : `<div class="empty-state">Chưa có lịch sử đấu cho giải này.</div>`
      }
    </div>
  `;
}

function renderDetailBracketStage(round, roundIndex, group = null) {
  const matches = group
    ? (round.matches || []).filter((match) => match.groupIndex === group.index)
    : (round.matches || []);
  const title = group ? `${round.title} • ${group.label}` : round.title;
  return `
    <section class="bracket-stage">
      <h4>${escapeHtml(title)}</h4>
      ${matches
        .map((match) => {
          const aWon = match.winner && match.winner === match.playerA;
          const bWon = match.winner && match.winner === match.playerB;
          const isLiveMatch = match.playerA && match.playerB && match.status === "live";
          return `
          <button class="bracket-mini-match${match.status === "done" ? " done" : ""}" data-open-match-camera="${Number(match.table) || match.matchIndex + 1}" type="button" ${isAdmin || isLiveMatch ? "" : "disabled"}>
            <span class="sr-only" data-live-match-info
              data-label="${escapeHtml(match.groupMatchLabel || `Trận ${match.matchIndex + 1}`)}"
              data-status="${matchStatusLabel(match.status)}"
              data-status-value="${escapeHtml(match.status || "pending")}"
              data-player-a="${escapeHtml(match.playerA || "TBD")}"
              data-score-a="${escapeHtml(match.scoreA || "-")}"
              data-player-b="${escapeHtml(match.playerB || "TBD")}"
              data-score-b="${escapeHtml(match.scoreB || "-")}"
              data-winner-a="${aWon ? "true" : "false"}"
              data-winner-b="${bWon ? "true" : "false"}"
              data-round-index="${roundIndex}"
              data-match-index="${match.matchIndex}"></span>
            <div class="mini-match-meta">
              <span>${escapeHtml(match.groupMatchLabel || `Trận ${match.matchIndex + 1}`)}</span>
              <small>Bàn ${String(match.table || match.matchIndex + 1).padStart(2, "0")}</small>
            </div>
            <div class="mini-player${aWon ? " winner" : ""}">
              <strong>${escapeHtml(match.playerA || "TBD")}</strong>
              <span>${escapeHtml(match.scoreA || "-")}</span>
            </div>
            <div class="mini-player${bWon ? " winner" : ""}">
              <strong>${escapeHtml(match.playerB || "TBD")}</strong>
              <span>${escapeHtml(match.scoreB || "-")}</span>
            </div>
          </button>
        `;
        })
        .join("")}
    </section>
  `;
}

function renderDetailBracket(entry) {
  const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
  const players = Array.isArray(entry.players) ? entry.players : [];
  const canManageBracket = isAdmin && entry.isCurrent;
  if (selectedDetailRoundIndex >= rounds.length) {
    selectedDetailRoundIndex = Math.max(0, rounds.length - 1);
  }
  const addRoundStatus = canManageBracket ? canAddGroupedRound() : { ok: false, message: "" };
  const canCreateEmptyBracket = canManageBracket && players.length >= 2;
  const selectedRound = rounds[selectedDetailRoundIndex];
  const selectedRoundMarkup = selectedRound
    ? isGroupedRound(selectedRound) && Array.isArray(selectedRound.groups) && selectedRound.groups.length
      ? selectedRound.groups.map((group) => renderDetailBracketStage(selectedRound, selectedDetailRoundIndex, group)).join("")
      : renderDetailBracketStage(selectedRound, selectedDetailRoundIndex)
    : "";
  const visiblePlayerNames = selectedRound?.sourcePlayers?.length
    ? selectedRound.sourcePlayers
    : players.map((player) => player.name);

  return `
    <div class="round-tab-shell">
      <div class="round-tab-header">
        ${
          rounds.length
            ? `
              <div class="round-tab-list" role="tablist" aria-label="Các vòng đấu">
                ${rounds.map((round, roundIndex) => `
                  <button class="round-tab${roundIndex === selectedDetailRoundIndex ? " active" : ""}" data-detail-round-tab="${roundIndex}" type="button">
                    ${escapeHtml(round.title || `Vòng ${roundIndex + 1}`)}
                  </button>
                `).join("")}
              </div>
            `
            : `<div class="round-tab-list"><button class="round-tab active" type="button">Sơ đồ đấu</button></div>`
        }
        ${
          canManageBracket
            ? `<div class="round-tab-actions">
                <button class="secondary-action round-add-action" data-detail-add-round type="button" ${addRoundStatus.ok ? "" : "disabled"} title="${escapeHtml(addRoundStatus.message)}">Thêm vòng đấu</button>
              </div>`
            : ""
        }
      </div>
      ${
        canManageBracket
          ? `<div class="round-tab-secondary-actions">
              <button class="secondary-action round-test-action" data-detail-fill-test-results type="button" ${rounds.length ? "" : "disabled"}>Điền kết quả test</button>
              <button class="danger-action round-delete-action" data-detail-delete-round type="button" ${rounds.length ? "" : "disabled"}>Xóa vòng hiện tại</button>
            </div>`
          : ""
      }
      ${
        canManageBracket
          ? `
            <div class="data-section wide-section inline-section bracket-draw-panel round-tab-player-panel">
              <div class="section-heading">
                <div>
                  <p>DANH SÁCH CƠ THỦ</p>
                  <h2>${visiblePlayerNames.length} cơ thủ</h2>
                </div>
                <div class="detail-bracket-actions">
                  <button class="primary-action" data-randomize-bracket type="button">Chia bảng ngẫu nhiên</button>
                  <button class="primary-action" data-detail-create-empty-bracket type="button" ${canCreateEmptyBracket ? "" : "disabled"} title="${canCreateEmptyBracket ? "Tạo bảng trống cho vòng đang chọn." : "Cần ít nhất 2 cơ thủ để tạo bảng trống."}">Tạo bảng trống</button>
                </div>
              </div>
              ${
                rounds.length
                  ? `<div class="form-status" data-type="${addRoundStatus.ok ? "ok" : ""}">${escapeHtml(addRoundStatus.message || "Tạo vòng bảng để bắt đầu sơ đồ đấu.")}</div>`
                  : ""
              }
              <div class="registered-player-grid">
                ${
                  visiblePlayerNames.length
                    ? visiblePlayerNames.map((name, index) => `<span>${index + 1}. ${escapeHtml(name)}</span>`).join("")
                    : `<span>Chưa có cơ thủ</span>`
                }
              </div>
            </div>
          `
          : ""
      }
      ${
        rounds.length
          ? `<div class="bracket-scroll detail-tree-scroll" aria-label="Sơ đồ cây thi đấu có thể cuộn ngang">
              <button class="bracket-fit-toggle" data-detail-bracket-fit type="button">Thu vừa màn hình</button>
              <div class="bracket" id="detailBracketCanvas"></div>
            </div>`
          : rounds.length
          ? `<div class="history-rounds detail-rounds round-tab-panel">${selectedRoundMarkup}</div>`
          : `<div class="empty-state">Chưa có sơ đồ đấu cho giải này.</div>`
      }
    </div>
  `;
}

function renderTournamentDirectory() {
  const list = document.querySelector("#tournamentList");
  const reader = document.querySelector("#tournamentReader");

  if (!list || !reader) {
    return;
  }

  const entries = getTournamentEntries();
  if (!entries.some((entry) => entry.id === selectedTournamentId)) {
    selectedTournamentId = entries[0]?.id || "current";
  }

  list.innerHTML = entries
    .map((entry) => {
      const tournament = entry.tournament || {};
      const players = Array.isArray(entry.players) ? entry.players : [];
      const matches = matchesForEntry(entry);
      const isActive = entry.id === selectedTournamentId;

      return `
        <button class="tournament-list-item${isActive ? " active" : ""}" data-tournament-id="${escapeHtml(entry.id)}" type="button">
          <strong>${escapeHtml(tournament.name || "Giải đấu chưa đặt tên")}</strong>
          <span>${escapeHtml(tournament.date || "Chưa chọn ngày")} • ${players.length} cơ thủ • ${matches.length} trận</span>
          <small>${entry.isCurrent ? "Đang mở" : `Đã lưu ${escapeHtml(new Date(entry.savedAt).toLocaleString("vi-VN"))}`}</small>
        </button>
      `;
    })
    .join("");

  list.querySelectorAll("[data-tournament-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedTournamentId = button.dataset.tournamentId;
      selectedTournamentDetailTab = "info";
      selectedDetailRoundIndex = 0;
      renderTournamentDirectory();
    });
  });

  const selectedEntry = entries.find((entry) => entry.id === selectedTournamentId) || entries[0];
  const detailTabs = isAdmin
    ? [
        ["info", "Thiết lập giải đấu"],
        ["players", "Thêm cơ thủ"],
        ["requests", "Yêu cầu"],
        ["history", "Lịch sử đấu"],
        ["bracket", "Sơ đồ đấu"],
      ]
    : [
        ["info", "Thông tin"],
        ["registration", "Đăng ký đấu giải"],
        ["history", "Lịch sử đấu"],
        ["bracket", "Sơ đồ đấu"],
      ];
  if (!detailTabs.some(([id]) => id === selectedTournamentDetailTab)) {
    selectedTournamentDetailTab = "info";
  }
  const detailContent = {
    info: renderDetailInfo(selectedEntry),
    registration: renderDetailRegistration(selectedEntry),
    players: renderDetailPlayersAdmin(selectedEntry),
    requests: renderDetailRequestsAdmin(selectedEntry),
    history: renderDetailHistory(selectedEntry),
    bracket: renderDetailBracket(selectedEntry),
  };

  reader.innerHTML = `
    <div class="tournament-reader-header">
      <div>
        <p>CHI TIẾT GIẢI</p>
        <h2>${escapeHtml(selectedEntry.tournament?.name || "Giải đấu chưa đặt tên")}</h2>
      </div>
      ${
        isAdmin
          ? `<button class="danger-action" data-delete-tournament="${escapeHtml(selectedEntry.id)}" type="button">Xóa giải đấu</button>`
          : ""
      }
    </div>
    <div class="detail-tabs" role="tablist" aria-label="Chi tiết giải đấu">
      ${detailTabs
        .map(([id, label]) => `<button class="detail-tab${selectedTournamentDetailTab === id ? " active" : ""}" data-detail-tab="${id}" type="button">${label}</button>`)
        .join("")}
    </div>
    <div class="detail-panel">${detailContent[selectedTournamentDetailTab] || detailContent.info}</div>
  `;

  const detailTreeCanvas = reader.querySelector("#detailBracketCanvas");
  if (detailTreeCanvas) {
    selectedBracketRoundIndex = selectedDetailRoundIndex;
    const originalTournament = state.tournament;
    const originalPlayers = state.players;
    const originalRounds = state.rounds;
    if (!selectedEntry.isCurrent) {
      state.tournament = selectedEntry.tournament || createDefaultState().tournament;
      state.players = Array.isArray(selectedEntry.players) ? selectedEntry.players : [];
      state.rounds = Array.isArray(selectedEntry.rounds) ? selectedEntry.rounds : [];
    }
    try {
      renderBracket();
    } finally {
      state.tournament = originalTournament;
      state.players = originalPlayers;
      state.rounds = originalRounds;
    }
    const sourceCanvas = document.querySelector("#bracketCanvas");
    if (sourceCanvas) {
      detailTreeCanvas.innerHTML = sourceCanvas.innerHTML;
      detailTreeCanvas.style.cssText = sourceCanvas.style.cssText;
    }
    bindDetailTreeNavigation(detailTreeCanvas.closest(".bracket-scroll"), detailTreeCanvas);
    if (selectedEntry.isCurrent) {
      detailTreeCanvas.querySelectorAll(".score-input").forEach((input) => {
        input.addEventListener("change", () => {
          updateMatchScore(Number(input.dataset.round), Number(input.dataset.match), input.dataset.field, input.value.trim());
        });
      });
      detailTreeCanvas.querySelectorAll(".match-status-select").forEach((select) => {
        select.addEventListener("change", () => {
          updateMatchStatus(Number(select.dataset.round), Number(select.dataset.match), select.value);
        });
      });
    } else {
      detailTreeCanvas.querySelectorAll("input, select, button").forEach((control) => {
        control.disabled = true;
      });
    }
  }

  reader.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedTournamentDetailTab = button.dataset.detailTab;
      if (isAdmin && selectedTournamentDetailTab === "requests") {
        loadRegistrationRequests().then(renderTournamentDirectory);
        return;
      }
      renderTournamentDirectory();
    });
  });
  reader.querySelectorAll("[data-detail-round-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedDetailRoundIndex = Number(button.dataset.detailRoundTab) || 0;
      selectedBracketRoundIndex = selectedDetailRoundIndex;
      selectedTournamentDetailTab = "bracket";
      renderTournamentDirectory();
    });
  });

  reader.querySelector("#directoryTournamentForm")?.addEventListener("submit", submitDirectoryTournamentForm);
  reader.querySelector("#directoryPlayerForm")?.addEventListener("submit", submitDirectoryPlayerForm);
  reader.querySelector("#directoryRegistrationForm")?.addEventListener("submit", submitDirectoryRegistrationRequest);
  reader.querySelector("[data-delete-tournament]")?.addEventListener("click", deleteSelectedTournament);
  reader.querySelector("[data-randomize-bracket]")?.addEventListener("click", () => {
    rebuildSelectedGroupedRound("random");
  });
  reader.querySelector("[data-detail-add-round]")?.addEventListener("click", () => {
    openAddRoundModal();
  });
  reader.querySelector("[data-detail-fill-test-results]")?.addEventListener("click", () => {
    fillSelectedRoundTestResults();
  });
  reader.querySelector("[data-detail-create-empty-bracket]")?.addEventListener("click", () => {
    createEmptyGroupedBracketFromDetail();
  });
  reader.querySelector("[data-detail-delete-round]")?.addEventListener("click", deleteSelectedDetailRound);
  reader.querySelectorAll("[data-open-match-camera]").forEach((button) => {
    button.addEventListener("click", () => {
      const liveInfo = button.querySelector("[data-live-match-info]");
      const matchInfo = liveInfo ? {
        label: liveInfo.dataset.label || "",
        status: liveInfo.dataset.status || "",
        statusValue: liveInfo.dataset.statusValue || "pending",
        playerA: liveInfo.dataset.playerA || "TBD",
        scoreA: liveInfo.dataset.scoreA || "-",
        playerB: liveInfo.dataset.playerB || "TBD",
        scoreB: liveInfo.dataset.scoreB || "-",
        winnerA: liveInfo.dataset.winnerA === "true",
        winnerB: liveInfo.dataset.winnerB === "true",
        roundIndex: Number(liveInfo.dataset.roundIndex),
        matchIndex: Number(liveInfo.dataset.matchIndex),
      } : { label: button.querySelector(".mini-match-meta span")?.textContent.trim() || "" };
      if (isAdmin && selectedEntry.isCurrent && Number.isInteger(matchInfo.roundIndex) && Number.isInteger(matchInfo.matchIndex)) {
        openMatchPairEditor(matchInfo.roundIndex, matchInfo.matchIndex);
        return;
      }
      if (!canOpenMatchLive(matchInfo)) {
        return;
      }
      window.openTournamentCameraTable?.(button.dataset.openMatchCamera, matchInfo);
    });
  });
  reader.querySelectorAll("[data-directory-remove-player]").forEach((button) => {
    button.addEventListener("click", () => {
      state.players = state.players.filter((player) => player.id !== button.dataset.directoryRemovePlayer);
      state.rounds = [];
      saveState();
      renderAll();
    });
  });
  reader.querySelectorAll("[data-directory-approve-request]").forEach((button) => {
    button.addEventListener("click", () => approveRegistrationRequest(button.dataset.directoryApproveRequest));
  });
  reader.querySelectorAll("[data-directory-reject-request]").forEach((button) => {
    button.addEventListener("click", () => rejectRegistrationRequest(button.dataset.directoryRejectRequest));
  });
}

function addGroupedRoundFromDetail(mode, reader) {
  const status = canAddGroupedRound();
  if (!status.ok) {
    setAdminNotice(status.message, "error");
    renderTournamentDirectory();
    return;
  }
  state.rounds.push(buildGroupedRound(nextGroupedRoundPlayers(), state.rounds.length, mode));
  saveState();
  selectedTournamentDetailTab = "bracket";
  selectedDetailRoundIndex = state.rounds.length - 1;
  selectedBracketRoundIndex = selectedDetailRoundIndex;
  renderAll();
  setAdminNotice(`Đã thêm ${state.rounds[state.rounds.length - 1].title}.`, "ok");
}

function setTestMatchResult(match, preferredSlot = "A") {
  if (!match?.playerA || !match.playerB) return false;
  const winnerIsA = preferredSlot !== "B";
  match.scoreA = winnerIsA ? "5" : "2";
  match.scoreB = winnerIsA ? "2" : "5";
  match.winner = winnerIsA ? match.playerA : match.playerB;
  match.status = "done";
  return true;
}

function fillSelectedRoundTestResults() {
  const roundIndex = Math.min(selectedDetailRoundIndex, state.rounds.length - 1);
  const round = state.rounds[roundIndex];
  if (!isGroupedRound(round)) {
    setAdminNotice("Vòng này không phải dạng bảng để điền kết quả test.", "error");
    return;
  }

  state.rounds = state.rounds.slice(0, roundIndex + 1);
  (round.groups || []).forEach((group) => {
    const groupMatches = round.matches.filter((match) => match.groupIndex === group.index);
    const openings = groupMatches.filter((match) => match.groupRole === "opening");
    const winnersMatch = groupMatches.find((match) => match.groupRole === "winners");
    const losersMatch = groupMatches.find((match) => match.groupRole === "losers");
    const deciderMatch = groupMatches.find((match) => match.groupRole === "decider");
    const finalMatch = groupMatches.find((match) => match.groupRole === "final");

    if (finalMatch) {
      setTestMatchResult(finalMatch, "A");
      return;
    }

    openings.forEach((match, index) => {
      setTestMatchResult(match, index % 2 === 0 ? "A" : "B");
    });
    recalculateGroupedRound(roundIndex);
    setTestMatchResult(winnersMatch, "A");
    setTestMatchResult(losersMatch, "A");
    recalculateGroupedRound(roundIndex);
    setTestMatchResult(deciderMatch, "B");
    recalculateGroupedRound(roundIndex);
  });

  saveState();
  selectedBracketRoundIndex = roundIndex;
  renderAll();
  setAdminNotice(`Đã điền kết quả test cho ${round.title}.`, "ok");
}

function rebuildSelectedGroupedRound(mode = "random") {
  const roundIndex = Math.min(selectedDetailRoundIndex, state.rounds.length - 1);
  const currentRound = state.rounds[roundIndex];
  const sourcePlayers = currentRound?.sourcePlayers?.length
    ? currentRound.sourcePlayers
    : roundIndex > 0
    ? nextGroupedRoundPlayers()
    : state.players.map((player) => player.name);
  const actionLabel = mode === "empty" ? "Tạo bảng trống" : "Chia bảng ngẫu nhiên";
  if (sourcePlayers.length < 2) {
    setAdminNotice(`Cần ít nhất 2 cơ thủ để ${actionLabel.toLowerCase()}.`, "error");
    return;
  }
  if (currentRound && !confirm(`${actionLabel} cho ${currentRound.title || "vòng đang chọn"} sẽ xoá điểm của vòng này và các vòng sau. Tiếp tục?`)) {
    return;
  }
  state.rounds = state.rounds.slice(0, Math.max(0, roundIndex));
  state.rounds.push(buildGroupedRound(sourcePlayers, roundIndex, mode));
  saveState();
  selectedTournamentDetailTab = "bracket";
  selectedDetailRoundIndex = roundIndex;
  selectedBracketRoundIndex = roundIndex;
  renderAll();
  setAdminNotice(`${actionLabel} cho ${state.rounds[roundIndex].title}.`, "ok");
}

function createEmptyGroupedBracketFromDetail() {
  rebuildSelectedGroupedRound("empty");
}

function deleteSelectedDetailRound() {
  if (!state.rounds.length) {
    setAdminNotice("Chưa có vòng đấu để xóa.", "error");
    return;
  }
  const roundIndex = Math.min(selectedDetailRoundIndex, state.rounds.length - 1);
  const roundTitle = state.rounds[roundIndex]?.title || "vòng hiện tại";
  if (!confirm(`Xóa ${roundTitle} và các vòng sau nó?`)) {
    return;
  }
  state.rounds = state.rounds.slice(0, roundIndex);
  selectedDetailRoundIndex = Math.max(0, state.rounds.length - 1);
  selectedBracketRoundIndex = selectedDetailRoundIndex;
  selectedTournamentDetailTab = "bracket";
  saveState();
  renderAll();
  setAdminNotice(`Đã xóa ${roundTitle}.`, "ok");
}

function submitDirectoryTournamentForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim() || "Ma Buu Billiards Tournament";
  const date = form.elements.date.value;
  const rank = form.elements.rank.value.trim();
  const organizer = form.elements.organizer.value.trim();
  const location = form.elements.location.value.trim();
  const description = form.elements.description.value.trim();

  if (selectedTournamentId === "current") {
    state.tournament = {
      ...state.tournament,
      name,
      date,
      rank,
      organizer,
      location,
      description,
    };
  } else {
    const entry = state.tournamentHistory.find((item) => item.id === selectedTournamentId);
    if (entry) {
      entry.tournament = {
        ...(entry.tournament || {}),
        name,
        date,
        rank,
        organizer,
        location,
        description,
      };
    }
  }

  saveState();
  renderAll();
  setAdminNotice(`Đã lưu thông tin ${name}.`, "ok");
}

function deleteSelectedTournament() {
  if (!isAdmin) {
    return;
  }

  const entries = getTournamentEntries();
  const entry = entries.find((item) => item.id === selectedTournamentId);
  const name = entry?.tournament?.name || "giải đấu này";
  if (!confirm(`Xóa ${name}? Dữ liệu giải này sẽ bị xóa khỏi danh sách.`)) {
    return;
  }

  archiveTournamentPlayerStats(entry);

  if (selectedTournamentId === "current") {
    const [nextEntry, ...remainingHistory] = state.tournamentHistory;
    if (nextEntry) {
      state.tournament = cloneData(nextEntry.tournament || createDefaultState().tournament);
      state.players = cloneData(nextEntry.players || []);
      state.rounds = cloneData(nextEntry.rounds || []);
      state.registrationRequests = [];
      state.tournamentHistory = remainingHistory;
    } else {
      const fresh = createDefaultState();
      state.tournament = fresh.tournament;
      state.players = fresh.players;
      state.rounds = fresh.rounds;
      state.registrationRequests = fresh.registrationRequests;
    }
    selectedTournamentId = "current";
  } else {
    state.tournamentHistory = state.tournamentHistory.filter((item) => item.id !== selectedTournamentId);
    selectedTournamentId = "current";
  }

  selectedTournamentDetailTab = "info";
  saveState();
  renderAll();
  setAdminNotice(`Đã xóa ${name}.`, "ok");
}

function submitDirectoryPlayerForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const rawName = form.elements.name.value.trim();
  const name = formatRankedPlayerName(rawName, form.elements.rank.value);

  if (!rawName) {
    form.elements.name.focus();
    return;
  }

  state.players.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    name,
    note: form.elements.note.value.trim(),
  });
  state.rounds = [];
  saveState();
  renderAll();
  setAdminNotice(`Đã thêm cơ thủ ${name}.`, "ok");
}

async function submitDirectoryRegistrationRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("#directoryRegistrationStatus");
  const rawName = form.elements.name.value.trim();
  const name = formatRankedPlayerName(rawName, form.elements.rank.value);
  const phone = form.elements.phone.value.trim();
  const note = form.elements.note.value.trim();

  if (!rawName || !phone) {
    status.textContent = "Vui lòng nhập tên và số điện thoại.";
    status.dataset.type = "error";
    return;
  }

  const client = getSupabaseClient();
  if (!client) {
    status.textContent = "Chưa cấu hình Supabase nên chưa gửi được yêu cầu.";
    status.dataset.type = "error";
    return;
  }

  status.textContent = "Đang gửi yêu cầu đăng ký...";
  try {
    const { error } = await client.from(getRegistrationRequestsTable()).insert({
      tournament_id: getSupabaseSettings().recordId || "main",
      tournament_name: state.tournament.name || "Ma Buu Billiards Tournament",
      name,
      phone,
      note,
      status: "pending",
    });

    if (error) {
      throw error;
    }

    form.reset();
    status.textContent = "Đã gửi yêu cầu. Admin sẽ duyệt thông tin của bạn.";
    status.dataset.type = "ok";
  } catch (error) {
    status.textContent = `Không gửi được yêu cầu: ${error.message}`;
    status.dataset.type = "error";
  }
}

function renderOverview() {
  const nameInput = document.querySelector("#tournamentName");
  const dateInput = document.querySelector("#tournamentDate");
  const rankInput = document.querySelector("#tournamentRank");
  const organizerInput = document.querySelector("#tournamentOrganizer");
  const locationInput = document.querySelector("#tournamentLocation");
  const descriptionInput = document.querySelector("#tournamentDescription");
  const cards = document.querySelector("#overviewCards");

  if (!nameInput || !dateInput || !cards) {
    return;
  }

  nameInput.value = state.tournament.name || "";
  dateInput.value = state.tournament.date || "";
  if (rankInput) rankInput.value = state.tournament.rank || "";
  if (organizerInput) organizerInput.value = state.tournament.organizer || "";
  if (locationInput) locationInput.value = state.tournament.location || "";
  if (descriptionInput) descriptionInput.value = state.tournament.description || "";

  const doneMatches = state.rounds.flatMap((round) => round.matches).filter((match) => match.status === "done").length;
  const totalMatches = state.rounds.flatMap((round) => round.matches).length;
  cards.innerHTML = `
    <article><small>Tên giải</small><strong>${escapeHtml(state.tournament.name || "Chưa thiết lập")}</strong></article>
    <article><small>Ngày thi đấu</small><strong>${escapeHtml(state.tournament.date || "Chưa chọn")}</strong></article>
    <article><small>Hạng giải</small><strong>${escapeHtml(state.tournament.rank || "Chưa nhập")}</strong></article>
    <article><small>Đơn vị tổ chức</small><strong>${escapeHtml(state.tournament.organizer || "Chưa nhập")}</strong></article>
    <article><small>Địa điểm</small><strong>${escapeHtml(state.tournament.location || "Chưa nhập")}</strong></article>
    <article><small>Cơ thủ</small><strong>${state.players.length}</strong></article>
    <article><small>Trận đã xong</small><strong>${doneMatches}/${totalMatches || 0}</strong></article>
    <article><small>Trạng thái</small><strong>${totalMatches && doneMatches === totalMatches ? "Hoàn tất" : "Đang diễn ra"}</strong></article>
  `;
}

function renderHomePlayerList(query = "") {
  const playerList = document.querySelector("#homePlayerList");
  const playerCount = document.querySelector("#homePlayerCount");

  if (!playerList) {
    return;
  }

  const normalizedQuery = query.trim().toLocaleLowerCase("vi");
  const visiblePlayers = normalizedQuery
    ? state.players.filter((player) => `${player.name || ""} ${player.rank || ""} ${player.note || ""}`.toLocaleLowerCase("vi").includes(normalizedQuery))
    : state.players;

  if (playerCount) {
    playerCount.textContent = state.players.length;
  }

  playerList.innerHTML = visiblePlayers.length
    ? visiblePlayers.map((player) => {
        const playerIndex = state.players.indexOf(player);
        const displayPlayer = splitRankedPlayerName(player.name, player.rank);
        return `
          <article class="home-player-row">
            <span>${playerIndex + 1}</span>
            <div class="home-player-identity">
              <i aria-hidden="true">${escapeHtml((displayPlayer.name || "?").charAt(0).toUpperCase())}</i>
              <strong>${escapeHtml(displayPlayer.name)}</strong>
            </div>
            <b>${escapeHtml(displayPlayer.rank)}</b>
            <button type="button" aria-label="Thông tin ${escapeHtml(player.name)}" title="${escapeHtml(player.note || player.name)}">i</button>
          </article>
        `;
      }).join("")
    : `<div class="home-player-empty">${state.players.length ? "Không tìm thấy cơ thủ phù hợp." : "Danh sách cơ thủ đang được cập nhật."}</div>`;
}

function renderHome() {
  const title = document.querySelector("#homeTournamentName");
  const stats = document.querySelector("#homeStats");
  const detailFacts = document.querySelector("#homeDetailFacts");
  const otherContent = document.querySelector("#homeOtherContent");

  renderAdminHomeTournamentList();
  if (!stats) {
    return;
  }

  const matches = allMatches();
  const doneMatches = matches.filter((match) => match.status === "done").length;
  const liveMatches = matches.filter((match) => match.playerA && match.playerB && match.status === "live").length;
  const waitingMatches = matches.length - doneMatches - liveMatches;
  const status = matches.length && doneMatches === matches.length ? "Hoàn tất" : "Đang diễn ra";

  if (title) title.textContent = state.tournament.name || "Ma Buu Billiards Tournament";
  renderHomePlayerList(document.querySelector("#homePlayerSearch")?.value || "");
  if (detailFacts) {
    detailFacts.innerHTML = `
      <div><small>Thời gian diễn ra</small><strong>${escapeHtml(state.tournament.date || "Đang cập nhật")}</strong></div>
      <div><small>Tổng số cơ thủ</small><strong>${state.players.length}</strong></div>
      <div><small>Hạng giải</small><strong>${escapeHtml(state.tournament.rank || "Đang cập nhật")}</strong></div>
      <div><small>Đơn vị tổ chức</small><strong>${escapeHtml(state.tournament.organizer || "Đang cập nhật")}</strong></div>
      <div><small>Địa điểm tổ chức</small><strong>${escapeHtml(state.tournament.location || "Đang cập nhật")}</strong></div>
    `;
  }
  if (otherContent) {
    otherContent.innerHTML = `
      <p>${state.tournament.description
        ? escapeHtml(state.tournament.description).replace(/\n/g, "<br>")
        : `Giải đấu <strong>${escapeHtml(state.tournament.name || "Ma Buu Billiards Tournament")}</strong> được tổ chức dành cho cộng đồng yêu billiards, với lịch thi đấu và kết quả được cập nhật trực tiếp.`}</p>
      <div class="home-other-tags">
        <span>${matches.length} trận đấu</span>
        <span>${state.rounds.length} vòng đấu</span>
        <span>Cập nhật trực tiếp</span>
      </div>
    `;
  }
  stats.innerHTML = `
    <article>
      <small>Trạng thái</small>
      <strong>${escapeHtml(status)}</strong>
    </article>
    <article>
      <small>Trận đang mở live</small>
      <strong>${liveMatches}</strong>
    </article>
    <article>
      <small>Trận đã xong</small>
      <strong>${doneMatches}/${matches.length || 0}</strong>
    </article>
    <article>
      <small>Trận chờ đấu</small>
      <strong>${Math.max(waitingMatches, 0)}</strong>
    </article>
  `;
}

function renderAdminHomeTournamentList() {
  const list = document.querySelector("#adminHomeTournamentList");
  if (!isAdmin || !list) return;

  const entries = getTournamentEntries();
  list.innerHTML = entries.map((entry) => {
    const tournament = entry.tournament || {};
    const players = Array.isArray(entry.players) ? entry.players : [];
    const matches = matchesForEntry(entry);
    const doneMatches = matches.filter((match) => match.status === "done").length;
    return `
      <button class="admin-tournament-card" data-admin-select-tournament="${escapeHtml(entry.id)}" type="button">
        <span class="admin-tournament-status${entry.isCurrent ? " current" : ""}">${entry.isCurrent ? "Đang mở" : "Đã lưu"}</span>
        <strong>${escapeHtml(tournament.name || "Giải đấu chưa đặt tên")}</strong>
        <small>${escapeHtml(tournament.date || "Chưa chọn ngày")}</small>
        <div><span>${players.length} cơ thủ</span><span>${doneMatches}/${matches.length} trận</span></div>
        <i>Xem và quản lý →</i>
      </button>
    `;
  }).join("");

  list.querySelectorAll("[data-admin-select-tournament]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedTournamentId = button.dataset.adminSelectTournament;
      selectedTournamentDetailTab = "info";
      selectedDetailRoundIndex = 0;
      renderTournamentDirectory();
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.hidden = panel.id !== "tournaments";
      });
      document.querySelectorAll(".main-nav .tab").forEach((tabButton) => tabButton.classList.remove("active"));
      document.querySelectorAll(".page-home-only").forEach((element) => {
        element.hidden = true;
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function hasOpenTournament() {
  return Boolean(state.tournament?.name || state.tournament?.date || state.players.length || state.rounds.length);
}

function renderRegistration() {
  if (isAdmin) {
    return;
  }

  const isOpen = hasOpenTournament();
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  const registrationPanel = document.querySelector("#registration");
  if (registrationPanel && activeTab === "registration") {
    registrationPanel.hidden = !isOpen;
  }

  const name = document.querySelector("#registrationTournamentName");
  const facts = document.querySelector("#registrationFacts");

  if (!name || !facts) {
    return;
  }

  name.textContent = state.tournament.name || "Ma Buu Billiards Tournament";
  facts.innerHTML = `
    <article><small>Ngày thi đấu</small><strong>${escapeHtml(state.tournament.date || "Chưa chọn")}</strong></article>
    <article><small>Đã duyệt</small><strong>${state.players.length} cơ thủ</strong></article>
    <article><small>Trạng thái</small><strong>Đang nhận đăng ký</strong></article>
  `;
}

function renderPlayers() {
  const list = document.querySelector("#playerList");
  const label = document.querySelector("#playerCountLabel");
  if (!list || !label) {
    return;
  }

  label.textContent = `${state.players.length} cơ thủ`;
  if (!state.players.length) {
    list.innerHTML = `<div class="empty-state">Chưa có cơ thủ. Thêm thủ công hoặc nạp mẫu để bắt đầu.</div>`;
    return;
  }

  list.innerHTML = state.players
    .map(
      (player, index) => `
        <article class="player-item">
          <div>
            <strong>${index + 1}. ${escapeHtml(player.name)}</strong>
            <span>${escapeHtml(player.note || "Chưa có ghi chú")}</span>
          </div>
          ${isAdmin ? `<button class="icon-action" data-remove-player="${player.id}" type="button" aria-label="Xoá ${escapeHtml(player.name)}">×</button>` : ""}
        </article>
      `,
    )
    .join("");

  list.querySelectorAll("[data-remove-player]").forEach((button) => {
    button.addEventListener("click", () => {
      state.players = state.players.filter((player) => player.id !== button.dataset.removePlayer);
      state.rounds = [];
      saveState();
      renderAll();
    });
  });
}

function renderRegistrationRequests() {
  if (!isAdmin) {
    return;
  }

  const list = document.querySelector("#registrationRequestList");
  const label = document.querySelector("#requestCountLabel");

  if (!list || !label) {
    return;
  }

  const pendingRequests = state.registrationRequests.filter((request) => request.status === "pending");
  label.textContent = `${pendingRequests.length} yêu cầu chờ duyệt`;

  if (!pendingRequests.length) {
    list.innerHTML = `<div class="empty-state">Chưa có yêu cầu đăng ký mới.</div>`;
    return;
  }

  list.innerHTML = pendingRequests
    .map(
      (request) => `
        <article class="request-item">
          <div>
            <strong>${escapeHtml(request.name)}</strong>
            <span>${escapeHtml(request.phone || "Chưa có số điện thoại")}</span>
            <small>${escapeHtml(request.note || "Không có ghi chú")} • ${escapeHtml(new Date(request.createdAt).toLocaleString("vi-VN"))}</small>
          </div>
          <div class="request-actions">
            <button class="primary-action" data-approve-request="${request.id}" type="button">Duyệt</button>
            <button class="danger-action" data-reject-request="${request.id}" type="button">Từ chối</button>
          </div>
        </article>
      `,
    )
    .join("");

  list.querySelectorAll("[data-approve-request]").forEach((button) => {
    button.addEventListener("click", () => approveRegistrationRequest(button.dataset.approveRequest));
  });

  list.querySelectorAll("[data-reject-request]").forEach((button) => {
    button.addEventListener("click", () => rejectRegistrationRequest(button.dataset.rejectRequest));
  });
}

function renderHistory() {
  const list = document.querySelector("#historyList");

  if (!list) {
    return;
  }

  if (!state.tournamentHistory.length) {
    list.innerHTML = `<div class="empty-state">Chưa có lịch sử giải đấu. Admin có thể lưu giải hiện tại trong tab Tải về.</div>`;
    return;
  }

  list.innerHTML = state.tournamentHistory
    .map((entry, index) => {
      const tournament = entry.tournament || {};
      const players = Array.isArray(entry.players) ? entry.players : [];
      const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
      const matches = rounds.flatMap((round) => (round.matches || []).map((match) => ({ ...match, roundTitle: round.title })));
      const doneMatches = entry.stats?.doneMatches ?? matches.filter((match) => match.status === "done").length;
      const totalMatches = entry.stats?.matches ?? matches.length;
      const openAttr = index === 0 ? " open" : "";

      return `
        <details class="history-item"${openAttr}>
          <summary>
            <div>
              <strong>${escapeHtml(tournament.name || "Giải đấu chưa đặt tên")}</strong>
              <span>${escapeHtml(tournament.date || "Chưa chọn ngày")} • ${players.length} cơ thủ • ${doneMatches}/${totalMatches || 0} trận</span>
            </div>
            <small>Lưu lúc ${escapeHtml(new Date(entry.savedAt).toLocaleString("vi-VN"))}</small>
          </summary>
          <div class="history-detail">
            <div class="history-block">
              <h3>Đăng ký đã duyệt</h3>
              <div class="history-player-grid">
                ${
                  players.length
                    ? players.map((player, playerIndex) => `<span>${playerIndex + 1}. ${escapeHtml(player.name)}</span>`).join("")
                    : `<span>Chưa có cơ thủ</span>`
                }
              </div>
            </div>
            <div class="history-block">
              <h3>Lịch đấu</h3>
              <div class="history-match-list">
                ${
                  matches.length
                    ? matches
                        .map(
                          (match) => `
                            <article>
                              <strong>${escapeHtml(match.roundTitle)} - Trận ${match.matchIndex + 1}</strong>
                              <span>${escapeHtml(match.playerA || "TBD")} vs ${escapeHtml(match.playerB || "TBD")}</span>
                              <small>Bàn ${String(match.table).padStart(2, "0")} • ${escapeHtml(match.scoreA || "-")} - ${escapeHtml(match.scoreB || "-")} • ${
                                matchStatusLabel(match.status)
                              }</small>
                            </article>
                          `,
                        )
                        .join("")
                    : `<div class="empty-state">Chưa có lịch đấu.</div>`
                }
              </div>
            </div>
            <div class="history-block">
              <h3>Sơ đồ đấu</h3>
              <div class="history-rounds">
                ${
                  rounds.length
                    ? rounds
                        .map(
                          (round) => `
                            <section>
                              <h4>${escapeHtml(round.title)}</h4>
                              ${(round.matches || [])
                                .map(
                                  (match) => `
                                    <article>
                                      <span>${escapeHtml(match.playerA || "TBD")} ${escapeHtml(match.scoreA || "-")}</span>
                                      <span>${escapeHtml(match.playerB || "TBD")} ${escapeHtml(match.scoreB || "-")}</span>
                                    </article>
                                  `,
                                )
                                .join("")}
                            </section>
                          `,
                        )
                        .join("")
                    : `<div class="empty-state">Chưa có sơ đồ đấu.</div>`
                }
              </div>
            </div>
          </div>
        </details>
      `;
    })
    .join("");
}

function allMatches() {
  return state.rounds.flatMap((round) => round.matches.map((match) => ({ ...match, roundTitle: round.title })));
}

function normalizePlayerKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matchesFromRounds(rounds = []) {
  return rounds.flatMap((round) => (round.matches || []).map((match) => ({ ...match, roundTitle: round.title })));
}

function addRankingPlayer(rows, name, tournamentId) {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  const key = normalizePlayerKey(cleanName);

  if (!key) {
    return null;
  }

  if (!rows.has(key)) {
    rows.set(key, {
      name: cleanName,
      played: 0,
      won: 0,
      lost: 0,
      tournaments: new Set(),
    });
  }

  const row = rows.get(key);
  if (tournamentId) {
    row.tournaments.add(tournamentId);
  }
  return row;
}

function mergeRankingRecord(rows, record) {
  const row = addRankingPlayer(rows, record.name, null);
  if (!row) {
    return;
  }

  row.played += Number(record.played) || 0;
  row.won += Number(record.won) || 0;
  row.lost += Number(record.lost) || 0;
  const tournamentCount = Number(record.tournamentCount) || 0;
  const startIndex = row.tournaments.size;
  for (let index = 0; index < tournamentCount; index += 1) {
    row.tournaments.add(`archived-${normalizePlayerKey(record.name)}-${startIndex + index}`);
  }
}

function tournamentRankingRecords(entry) {
  const rows = new Map();
  const tournamentId = entry.id || `deleted-${Date.now()}`;
  const ignoredResults = new Set(state.rankingIgnoredResults || []);
  if (!ignoredResults.size) {
    (entry.players || []).forEach((player) => addRankingPlayer(rows, player.name, tournamentId));
    matchesFromRounds(entry.rounds)
      .filter((match) => match.playerA || match.playerB)
      .forEach((match) => {
        addRankingPlayer(rows, match.playerA, tournamentId);
        addRankingPlayer(rows, match.playerB, tournamentId);
      });
  }

  matchesFromRounds(entry.rounds)
    .filter((match) => match.status === "done" && match.playerA && match.playerB && !ignoredResults.has(rankingResultKey(tournamentId, match)))
    .forEach((match) => {
      const a = addRankingPlayer(rows, match.playerA, tournamentId);
      const b = addRankingPlayer(rows, match.playerB, tournamentId);
      const scoreA = Number(match.scoreA);
      const scoreB = Number(match.scoreB);
      if (!a || !b || !Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) {
        return;
      }

      a.played += 1;
      b.played += 1;
      if (scoreA > scoreB) {
        a.won += 1;
        b.lost += 1;
      } else {
        b.won += 1;
        a.lost += 1;
      }
    });

  return [...rows.values()].map((row) => ({
    name: row.name,
    played: row.played,
    won: row.won,
    lost: row.lost,
    tournamentCount: row.tournaments.size,
  }));
}

function archiveTournamentPlayerStats(entry) {
  if (!entry) {
    return;
  }

  const rows = new Map();
  (state.playerStats || []).forEach((record) => mergeRankingRecord(rows, record));
  tournamentRankingRecords(entry).forEach((record) => mergeRankingRecord(rows, record));
  state.playerStats = [...rows.values()].map((row) => ({
    name: row.name,
    played: row.played,
    won: row.won,
    lost: row.lost,
    tournamentCount: row.tournaments.size,
  }));
}

function rankingResultKey(entryId, match) {
  return `${entryId}:${match.id || `${match.roundIndex}-${match.matchIndex}`}:${match.playerA || ""}:${match.playerB || ""}:${match.scoreA || ""}:${match.scoreB || ""}`;
}

function collectRankingRows() {
  const rows = new Map();
  const excludedPlayers = new Set((state.rankingExcludedPlayers || []).map(normalizePlayerKey));
  const entries = [
    {
      id: "current",
      players: state.players,
      rounds: state.rounds,
    },
    ...state.tournamentHistory.map((entry) => ({
      id: entry.id,
      players: entry.players || [],
      rounds: entry.rounds || [],
    })),
  ];
  const ignoredResults = new Set(state.rankingIgnoredResults || []);

  (state.playerStats || []).forEach((record) => mergeRankingRecord(rows, record));

  if (!ignoredResults.size) entries.forEach((entry) => {
    (entry.players || []).forEach((player) => addRankingPlayer(rows, player.name, entry.id));
    matchesFromRounds(entry.rounds)
      .filter((match) => match.playerA || match.playerB)
      .forEach((match) => {
        addRankingPlayer(rows, match.playerA, entry.id);
        addRankingPlayer(rows, match.playerB, entry.id);
      });
  });

  entries.forEach((entry) => {
    matchesFromRounds(entry.rounds)
      .filter((match) => match.status === "done" && match.playerA && match.playerB && !ignoredResults.has(rankingResultKey(entry.id, match)))
      .forEach((match) => {
        const a = addRankingPlayer(rows, match.playerA, entry.id);
        const b = addRankingPlayer(rows, match.playerB, entry.id);
        const scoreA = Number(match.scoreA);
        const scoreB = Number(match.scoreB);
        if (!a || !b || !Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) {
          return;
        }

        a.played += 1;
        b.played += 1;
        if (scoreA > scoreB) {
          a.won += 1;
          b.lost += 1;
        } else {
          b.won += 1;
          a.lost += 1;
        }
      });
  });

  return [...rows.values()]
    .filter((row) => !excludedPlayers.has(normalizePlayerKey(row.name)))
    .map((row) => ({
      ...row,
      tournamentCount: row.tournaments.size,
      winRate: row.played ? Math.round((row.won / row.played) * 100) : 0,
    }));
}

function renderSchedule() {
  const body = document.querySelector("#scheduleBody");
  if (!body) {
    return;
  }

  const matches = allMatches();
  if (!matches.length) {
    body.innerHTML = `<tr><td colspan="7">Chưa có lịch. Hãy tạo bracket trước.</td></tr>`;
    return;
  }

  body.innerHTML = matches
    .map(
      (match) => `
        <tr>
          <td>${escapeHtml(match.roundTitle)}</td>
          <td>${match.matchIndex + 1}</td>
          <td>${escapeHtml(match.time || "Chưa xếp")}</td>
          <td>Bàn ${String(match.table).padStart(2, "0")}</td>
          <td>${escapeHtml(match.playerA || "TBD")} vs ${escapeHtml(match.playerB || "TBD")}</td>
          <td>${escapeHtml(match.scoreA || "-")} - ${escapeHtml(match.scoreB || "-")}</td>
          <td>${matchStatusLabel(match.status)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderRanking() {
  const body = document.querySelector("#rankingBody");
  if (!body) {
    return;
  }

  const ranking = collectRankingRows().sort(
    (a, b) =>
      b.won - a.won ||
      b.played - a.played ||
      b.winRate - a.winRate ||
      a.name.localeCompare(b.name, "vi"),
  );
  body.innerHTML = ranking.length
    ? ranking
        .map(
          (row, index) => {
            const displayPlayer = splitRankedPlayerName(row.name);
            return `
            <tr>
              <td>${index + 1}</td>
              <td>${escapeHtml(displayPlayer.name)}</td>
              <td>${escapeHtml(displayPlayer.rank)}</td>
              <td>${row.played}</td>
              <td>${row.won}</td>
              <td>${row.lost}</td>
              <td>${row.winRate}% • ${row.tournamentCount} giải</td>
            </tr>
          `;
          },
        )
        .join("")
    : `<tr><td colspan="7">Chưa có dữ liệu xếp hạng.</td></tr>`;
}

function renderTournamentRanking() {
  const body = document.querySelector("#tournamentRankingBody");
  const title = document.querySelector("#tournamentRankingTitle");
  if (!body) {
    return;
  }

  if (title) {
    title.textContent = state.tournament.name || "Giải hiện tại";
  }

  const currentRows = new Map();
  state.players.forEach((player) => addRankingPlayer(currentRows, player.name, "current"));
  tournamentRankingRecords({
    id: "current",
    players: state.players,
    rounds: state.rounds,
  }).forEach((record) => mergeRankingRecord(currentRows, record));

  const ranking = [...currentRows.values()]
    .map((row) => ({
      ...row,
      winRate: row.played ? Math.round((row.won / row.played) * 100) : 0,
    }))
    .sort(
      (a, b) =>
        b.won - a.won ||
        b.played - a.played ||
        b.winRate - a.winRate ||
        a.name.localeCompare(b.name, "vi"),
    );

  body.innerHTML = ranking.length
    ? ranking.map((row, index) => {
        const displayPlayer = splitRankedPlayerName(row.name);
        return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(displayPlayer.name)}</td>
          <td>${escapeHtml(displayPlayer.rank)}</td>
          <td>${row.played}</td>
          <td>${row.won}</td>
          <td>${row.lost}</td>
          <td>${row.winRate}%</td>
        </tr>
      `;
      }).join("")
    : `<tr><td colspan="7">Chưa có cơ thủ trong giải này.</td></tr>`;
}

function contactMapEmbedUrl(contact) {
  const query = contact.address || contact.mapsUrl || contact.name || "Ma Buu Billiards";
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (error) {
    return "";
  }
}

function renderContact() {
  const contact = {
    ...createDefaultState().contact,
    ...(state.contact || {}),
  };
  const name = document.querySelector("#contactDisplayName");
  const list = document.querySelector("#contactDisplayList");
  const map = document.querySelector("#contactMap");
  const mapsUrl = safeHttpUrl(contact.mapsUrl);

  if (name) name.textContent = contact.name || "Ma Buu Billiards";
  if (list) {
    list.innerHTML = `
      <article><small>Địa điểm</small><strong>${escapeHtml(contact.address || "Đang cập nhật")}</strong></article>
      ${contact.phone ? `<article><small>Điện thoại</small><a href="tel:${escapeHtml(contact.phone.replace(/\s/g, ""))}">${escapeHtml(contact.phone)}</a></article>` : ""}
      ${contact.email ? `<article><small>Email</small><a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a></article>` : ""}
      ${contact.note ? `<article><small>Thông tin</small><strong>${escapeHtml(contact.note)}</strong></article>` : ""}
      ${mapsUrl ? `<article><small>Chỉ đường</small><a href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">Mở Google Maps</a></article>` : ""}
    `;
  }
  if (map) {
    map.src = contactMapEmbedUrl(contact);
    map.title = `Bản đồ ${contact.name || "Ma Buu Billiards"}`;
  }

  const fields = {
    contactName: contact.name,
    contactAddress: contact.address,
    contactPhone: contact.phone,
    contactEmail: contact.email,
    contactMapsUrl: contact.mapsUrl,
    contactNote: contact.note,
  };
  Object.entries(fields).forEach(([id, value]) => {
    const input = document.querySelector(`#${id}`);
    if (input && document.activeElement !== input) input.value = value || "";
  });
}

function renderDownload() {
  const summary = document.querySelector("#downloadSummary");
  if (!summary) {
    return;
  }

  summary.textContent = state.rounds.length
    ? `Có ${state.players.length} cơ thủ và ${allMatches().length} trận trong bracket hiện tại.`
    : "Chưa có dữ liệu để tải về.";
}

function normalizeLanCamera(item) {
  const table = Number(item?.table);
  const address = String(item?.address || "").trim();
  const verifyCode = String(item?.verifyCode || "").trim();
  if (!Number.isInteger(table) || table <= 0 || !address) {
    return null;
  }
  return { table, address, verifyCode };
}

function normalizeAppPin(value) {
  const pin = String(value || "").replace(/\D/g, "");
  return pin.length === 6 ? pin : "";
}

function normalizeAdBanner(value) {
  return {
    enabled: Boolean(value?.enabled),
    name: String(value?.name || "").trim().replace(/[\\/]/g, "-"),
    url: String(value?.url || "").trim(),
  };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(reader.error || new Error("Không đọc được hình."));
    reader.readAsDataURL(file);
  });
}

async function uploadAdBannerFile(file) {
  const client = getSupabaseClient();
  const { data: sessionData } = await client.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) throw new Error("Phiên đăng nhập admin đã hết hạn. Hãy đăng nhập lại.");
  const response = await fetch("/api/ad-banner-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ name: file.name, type: file.type, data: await readFileAsBase64(file) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.message || `Tải hình thất bại (HTTP ${response.status}).`);
  return result;
}

function renderAdBannerSettings() {
  const name = document.querySelector("#adBannerName");
  const url = document.querySelector("#adBannerUrl");
  const enabled = document.querySelector("#adBannerEnabled");
  const summary = document.querySelector("#adBannerSummary");
  const preview = document.querySelector("#adBannerPreview");
  if (!name || !url || !enabled || !summary || !preview) return;
  const banner = normalizeAdBanner(state.adBanner);
  if (document.activeElement !== name) name.value = banner.name;
  if (document.activeElement !== url) url.value = banner.url;
  enabled.checked = banner.enabled;
  summary.textContent = banner.name || "Chưa cấu hình banner";
  preview.innerHTML = banner.url
    ? `<img src="${escapeHtml(banner.url)}" alt="Xem trước ${escapeHtml(banner.name || "banner")}" />`
    : "<span>Chưa có hình</span>";
}

function renderAppPinSettings() {
  const input = document.querySelector("#appPinInput");
  const summary = document.querySelector("#appPinSummary");
  const dots = document.querySelector("#appPinDots");
  const savedCard = document.querySelector("#savedAppPinCard");
  if (!input || !summary || !dots || !savedCard) return;
  const pin = normalizeAppPin(state.appPin) || "123456";
  if (pendingAppPin === null) pendingAppPin = "";
  input.value = pendingAppPin;
  summary.textContent = `${pin.length} số`;
  savedCard.textContent = pin;
  dots.innerHTML = Array.from({ length: 6 }, (_, index) =>
    `<span class="${index < pendingAppPin.length ? "filled" : ""}">${escapeHtml(pendingAppPin[index] || "")}</span>`,
  ).join("");
}

function parseLanCameraLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line, index) => {
      const parts = line.split("|").map((part) => part.trim());
      if (!parts.some(Boolean)) return null;
      if (parts.length < 3) {
        throw new Error(`Dòng ${index + 1} chưa đúng định dạng BÀN SỐ|IP:PORT|Mã vr`);
      }
      const table = Number(parts[0].replace(/\D/g, ""));
      const camera = normalizeLanCamera({
        table,
        address: parts[1],
        verifyCode: parts.slice(2).join("|"),
      });
      if (!camera) {
        throw new Error(`Dòng ${index + 1} chưa có bàn số hoặc IP:PORT hợp lệ`);
      }
      return camera;
    })
    .filter(Boolean)
    .sort((a, b) => a.table - b.table);
}

function lanCameraLines(cameras = state.lanCameras) {
  return (Array.isArray(cameras) ? cameras : [])
    .map(normalizeLanCamera)
    .filter(Boolean)
    .sort((a, b) => a.table - b.table)
    .map((camera) => `${camera.table}|${camera.address}|${camera.verifyCode}`)
    .join("\n");
}

function renderLanCameraSettings() {
  const input = document.querySelector("#lanCameraListInput");
  const count = document.querySelector("#lanCameraCountLabel");
  const list = document.querySelector("#lanCameraPreviewList");
  if (!input || !count || !list) return;

  input.value = lanCameraLines();
  const cameras = (state.lanCameras || []).map(normalizeLanCamera).filter(Boolean).sort((a, b) => a.table - b.table);
  count.textContent = `${cameras.length} camera`;
  list.innerHTML = cameras.length
    ? cameras.map((camera) => `
        <article class="lan-camera-item">
          <strong>Bàn ${String(camera.table).padStart(2, "0")}</strong>
          <span>${escapeHtml(camera.address)}</span>
          <small>${camera.verifyCode ? "Đã có mã vr" : "Chưa có mã vr"}</small>
        </article>
      `).join("")
    : `<div class="empty-state">Chưa có camera nội bộ. Nhập theo định dạng BÀN SỐ|IP:PORT|Mã vr.</div>`;
}

function renderCameraViewPanels() {
  document.querySelectorAll("[data-camera-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.cameraViewPanel !== selectedCameraView;
  });
  document.querySelectorAll("[data-camera-view]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.cameraView === selectedCameraView);
  });
}

function renderAll() {
  renderTournamentDirectory();
  renderHome();
  renderOverview();
  renderRegistration();
  renderPlayers();
  renderRegistrationRequests();
  renderBracket();
  renderSchedule();
  renderRanking();
  renderTournamentRanking();
  renderContact();
  renderHistory();
  renderLanCameraSettings();
  renderCameraViewPanels();
  renderAppPinSettings();
  renderAdBannerSettings();
  renderDownload();
  renderAddRoundStatus();
  keepActivePanelVisible();
}

function downloadFile(filename, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTournamentHistorySnapshot() {
  const matches = allMatches();

  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    savedAt: new Date().toISOString(),
    tournament: cloneData(state.tournament),
    players: cloneData(state.players),
    rounds: cloneData(state.rounds),
    stats: {
      players: state.players.length,
      matches: matches.length,
      doneMatches: matches.filter((match) => match.status === "done").length,
    },
  };
}

function saveTournamentToHistory() {
  if (!hasCurrentTournamentContent()) {
    setAdminNotice("Chưa có dữ liệu giải để lưu vào lịch sử.", "error");
    return;
  }

  const snapshot = createTournamentHistorySnapshot();
  state.tournamentHistory = [snapshot, ...state.tournamentHistory.filter((item) => item.id !== snapshot.id)];
  saveState();
  renderAll();
  setAdminNotice(`Đã lưu ${snapshot.tournament.name || "giải đấu"} vào lịch sử.`, "ok");
}

function openCreateTournamentModal() {
  const modal = document.querySelector("#createTournamentModal");
  const nameInput = document.querySelector("#newTournamentName");
  const dateInput = document.querySelector("#newTournamentDate");

  if (!modal || !nameInput || !dateInput) {
    document.querySelector("#tournamentName")?.focus();
    return;
  }

  nameInput.value = "";
  dateInput.value = new Date().toISOString().slice(0, 10);
  modal.hidden = false;
  nameInput.focus();
}

function closeCreateTournamentModal() {
  const modal = document.querySelector("#createTournamentModal");
  if (modal) {
    modal.hidden = true;
  }
}

function closeManualPairingModal() {
  const modal = document.querySelector("#manualPairingModal");
  if (modal) modal.hidden = true;
}

function openManualPairingModal() {
  if (state.players.length < 2 || state.players.length % 2 !== 0) {
    alert("Cần số lượng cơ thủ chẵn để xếp cặp thủ công.");
    return;
  }
  const modal = document.querySelector("#manualPairingModal");
  const list = document.querySelector("#manualPairingList");
  const status = document.querySelector("#manualPairingStatus");
  if (!modal || !list) return;
  const options = (selectedId) => state.players.map((player) =>
    `<option value="${escapeHtml(player.id)}"${player.id === selectedId ? " selected" : ""}>${escapeHtml(player.name)}</option>`,
  ).join("");
  list.innerHTML = Array.from({ length: state.players.length / 2 }, (_, matchIndex) => {
    const playerA = state.players[matchIndex * 2];
    const playerB = state.players[matchIndex * 2 + 1];
    return `<div class="manual-pairing-row">
      <strong>Trận ${matchIndex + 1}</strong>
      <select data-manual-slot>${options(playerA.id)}</select>
      <span>VS</span>
      <select data-manual-slot>${options(playerB.id)}</select>
    </div>`;
  }).join("");
  const pairingSelects = [...list.querySelectorAll("[data-manual-slot]")];
  pairingSelects.forEach((select) => {
    select.dataset.previousValue = select.value;
    select.addEventListener("change", () => {
      const previousValue = select.dataset.previousValue;
      const duplicateSelect = pairingSelects.find((other) => other !== select && other.value === select.value);
      if (duplicateSelect) {
        duplicateSelect.value = previousValue;
        duplicateSelect.dataset.previousValue = previousValue;
      }
      select.dataset.previousValue = select.value;
      if (status) {
        status.textContent = duplicateSelect ? "Đã hoán đổi vị trí hai cơ thủ." : "Đã cập nhật cặp đấu.";
        status.dataset.type = "ok";
      }
    });
  });
  if (status) {
    status.textContent = "Chọn một cơ thủ đã có trong cặp khác để tự động hoán đổi vị trí.";
    status.dataset.type = "";
  }
  modal.hidden = false;
}

function submitManualPairing(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("#manualPairingStatus");
  const selectedIds = [...form.querySelectorAll("[data-manual-slot]")].map((select) => select.value);
  if (new Set(selectedIds).size !== state.players.length) {
    status.textContent = "Có cơ thủ bị chọn trùng hoặc chưa được xếp cặp.";
    status.dataset.type = "error";
    return;
  }
  if (state.rounds.length && !confirm("Tạo cặp mới sẽ xóa điểm và kết quả bracket hiện tại. Tiếp tục?")) return;
  const playersById = new Map(state.players.map((player) => [player.id, player]));
  state.players = selectedIds.map((id) => playersById.get(id)).filter(Boolean);
  state.rounds = [];
  closeManualPairingModal();
  buildBracket(false);
  setAdminNotice("Đã tạo bracket theo cặp thủ công.", "ok");
}

function nextGroupedRoundPlayers() {
  const lastRound = state.rounds[state.rounds.length - 1];
  if (isGroupedRound(lastRound)) return groupedRoundWinners(lastRound);
  return (lastRound?.matches || [])
    .filter((match) => match.status === "done" && match.winner)
    .map((match) => match.winner);
}

function canAddGroupedRound() {
  const lastRound = state.rounds[state.rounds.length - 1];
  if (!lastRound) {
    return { ok: false, message: "Hãy tạo vòng bảng trước." };
  }
  if ((lastRound.matches || []).some((match) => match.status !== "done" || !match.winner)) {
    return { ok: false, message: "Cần nhập kết quả xong toàn bộ trận ở vòng trước." };
  }
  const roundPlayers = isGroupedRound(lastRound)
    ? groupedRoundPlayerNames(lastRound)
    : (lastRound.sourcePlayers || []);
  if (roundPlayers.length < (lastRound.sourcePlayers || []).length) {
    return { ok: false, message: "Cần xếp đủ cơ thủ vào vòng hiện tại trước khi thêm vòng mới." };
  }
  const winners = nextGroupedRoundPlayers();
  if (winners.length < 2) {
    return { ok: false, message: "Không còn đủ 2 cơ thủ để tạo vòng tiếp theo." };
  }
  if (winners.length === roundPlayers.length) {
    return { ok: false, message: "Vòng trước chưa loại được người chơi nào." };
  }
  if (lastRound.title === "Chung kết") {
    return { ok: false, message: "Giải đã đến chung kết." };
  }
  return { ok: true, message: `${winners.length} cơ thủ thắng sẽ vào ${groupedRoundTitle(state.rounds.length, winners.length)}.` };
}

function renderAddRoundStatus() {
  const button = document.querySelector("#addTournamentRound");
  const emptyButton = document.querySelector("#addEmptyTournamentRound");
  const status = canAddGroupedRound();
  const canCreateEmptyBracket = state.players.length >= 2;
  if (button) {
    button.disabled = !status.ok;
    button.title = status.message;
  }
  if (emptyButton) {
    emptyButton.disabled = !canCreateEmptyBracket;
    emptyButton.title = canCreateEmptyBracket ? "Tạo vòng bảng trống từ danh sách cơ thủ hiện tại." : "Cần ít nhất 2 cơ thủ để tạo bảng trống.";
  }
  const modalStatus = document.querySelector("#addRoundStatus");
  if (modalStatus) {
    modalStatus.textContent = status.message;
    modalStatus.dataset.type = status.ok ? "ok" : "error";
  }
}

function openAddRoundModal() {
  const status = canAddGroupedRound();
  if (!status.ok) {
    alert(status.message);
    renderAddRoundStatus();
    return;
  }
  const modal = document.querySelector("#addRoundModal");
  const formatInput = document.querySelector("#addRoundFormat");
  renderAddRoundStatus();
  if (formatInput) formatInput.value = "single";
  if (modal) modal.hidden = false;
}

function closeAddRoundModal() {
  const modal = document.querySelector("#addRoundModal");
  if (modal) modal.hidden = true;
}

function submitAddRound(event) {
  event.preventDefault();
  const formatInput = document.querySelector("#addRoundFormat");
  addGroupedRound(formatInput?.value || "single");
}

function addGroupedRound(format = "single") {
  const status = canAddGroupedRound();
  const statusEl = document.querySelector("#addRoundStatus");
  if (!status.ok) {
    if (statusEl) {
      statusEl.textContent = status.message;
      statusEl.dataset.type = "error";
    }
    return;
  }
  const winners = nextGroupedRoundPlayers();
  const nextRound = format === "grouped"
    ? buildGroupedRound(winners, state.rounds.length, "random")
    : buildSingleEliminationRound(winners, state.rounds.length);
  state.rounds.push(nextRound);
  selectedDetailRoundIndex = state.rounds.length - 1;
  selectedBracketRoundIndex = selectedDetailRoundIndex;
  saveState();
  renderAll();
  closeAddRoundModal();
  setAdminNotice(`Đã thêm ${state.rounds[state.rounds.length - 1].title}.`, "ok");
}

function closeMatchPairEditor() {
  const modal = document.querySelector("#matchPairEditorModal");
  if (modal) modal.hidden = true;
}

function openMatchPairEditor(roundIndex, matchIndex) {
  const match = state.rounds[roundIndex]?.matches[matchIndex];
  const round = state.rounds[roundIndex];
  const modal = document.querySelector("#matchPairEditorModal");
  if (!match || !modal) return;
  const eligibleNames = isGroupedRound(round) && Array.isArray(round.sourcePlayers) && round.sourcePlayers.length
    ? round.sourcePlayers
    : state.players.map((player) => player.name);
  const optionMarkup = (current) => [
    `<option value="">Chờ tự động</option>`,
    ...eligibleNames.map((name) => `<option value="${escapeHtml(name)}"${name === current ? " selected" : ""}>${escapeHtml(name)}</option>`),
  ].join("");
  document.querySelector("#matchPairRound").value = roundIndex;
  document.querySelector("#matchPairMatch").value = matchIndex;
  document.querySelector("#matchPairEditorTitle").textContent = `${state.rounds[roundIndex].title} • Trận ${matchIndex + 1}`;
  document.querySelector("#matchPairPlayerA").innerHTML = optionMarkup(match.playerA);
  document.querySelector("#matchPairPlayerB").innerHTML = optionMarkup(match.playerB);
  const status = document.querySelector("#matchPairEditorStatus");
  status.textContent = "Chọn hai cơ thủ hoặc để Chờ tự động.";
  status.dataset.type = "";
  modal.hidden = false;
}

function submitMatchPairEditor(event) {
  event.preventDefault();
  const roundIndex = Number(document.querySelector("#matchPairRound").value);
  const matchIndex = Number(document.querySelector("#matchPairMatch").value);
  const playerASelect = document.querySelector("#matchPairPlayerA");
  const playerBSelect = document.querySelector("#matchPairPlayerB");
  const status = document.querySelector("#matchPairEditorStatus");
  let playerA = playerASelect.value || null;
  let playerB = playerBSelect.value || null;
  if (playerA && playerA === playerB) {
    status.textContent = "Hai vị trí không thể chọn cùng một cơ thủ.";
    status.dataset.type = "error";
    return;
  }
  updateMatchPlayers(roundIndex, matchIndex, playerA, playerB);
  closeMatchPairEditor();
  setAdminNotice("Đã cập nhật cặp đấu.", "ok");
}

function createNewTournamentFromModal(event) {
  event.preventDefault();
  const nameInput = document.querySelector("#newTournamentName");
  const dateInput = document.querySelector("#newTournamentDate");
  const name = nameInput?.value.trim();

  if (!name) {
    nameInput?.focus();
    return;
  }

  if (hasCurrentTournamentContent()) {
    const snapshot = createTournamentHistorySnapshot();
    state.tournamentHistory = [snapshot, ...state.tournamentHistory.filter((item) => item.id !== snapshot.id)];
  }

  state.tournament = {
    ...createDefaultState().tournament,
    name,
    date: dateInput?.value || new Date().toISOString().slice(0, 10),
    format: "single",
  };
  state.players = [];
  state.registrationRequests = [];
  state.rounds = [];
  selectedTournamentId = "current";
  selectedTournamentDetailTab = "info";
  saveState();
  renderAll();
  closeCreateTournamentModal();
  document.querySelector('[data-tab="tournaments"]')?.click();
  setAdminNotice(`Đã tạo giải đấu ${name}.`, "ok");
}

async function submitRegistrationRequest(form) {
  const nameInput = form.querySelector("#registrationName");
  const rankInput = form.querySelector("#registrationRank");
  const phoneInput = form.querySelector("#registrationPhone");
  const noteInput = form.querySelector("#registrationNote");
  const rawName = nameInput.value.trim();
  const name = formatRankedPlayerName(rawName, rankInput?.value || "K");
  const phone = phoneInput.value.trim();

  if (!rawName || !phone) {
    setRegistrationStatus("Vui lòng nhập tên và số điện thoại.", "error");
    return;
  }

  const client = getSupabaseClient();

  if (!client) {
    setRegistrationStatus("Chưa cấu hình Supabase nên chưa gửi được yêu cầu.", "error");
    return;
  }

  setRegistrationStatus("Đang gửi yêu cầu đăng ký...");

  try {
    const { error } = await client.from(getRegistrationRequestsTable()).insert({
      tournament_id: getSupabaseSettings().recordId || "main",
      tournament_name: state.tournament.name || "Ma Buu Billiards Tournament",
      name,
      phone,
      note: noteInput.value.trim(),
      status: "pending",
    });

    if (error) {
      throw error;
    }

    form.reset();
    renderAll();
    setRegistrationStatus("Đã gửi yêu cầu. Admin sẽ duyệt thông tin của bạn.", "ok");
  } catch (error) {
    setRegistrationStatus(`Không gửi được yêu cầu: ${error.message}`, "error");
  }
}

async function approveRegistrationRequest(requestId) {
  const request = state.registrationRequests.find((item) => item.id === requestId);

  if (!request) {
    return;
  }

  try {
    await updateRegistrationRequestStatus(requestId, "approved");

    const alreadyAdded = state.players.some((player) => player.name.trim().toLowerCase() === request.name.trim().toLowerCase());
    if (!alreadyAdded) {
      state.players.push({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        name: request.name,
        note: [request.note, request.phone].filter(Boolean).join(" - "),
      });
    }

    request.status = "approved";
    request.reviewedAt = new Date().toISOString();
    state.rounds = [];
    saveState();
    await loadRegistrationRequests();
    renderAll();
    setAdminNotice(`Đã duyệt đăng ký của ${request.name}.`, "ok");
  } catch (error) {
    setAdminNotice(`Không duyệt được đăng ký: ${error.message}`, "error");
  }
}

async function rejectRegistrationRequest(requestId) {
  const request = state.registrationRequests.find((item) => item.id === requestId);

  if (!request) {
    return;
  }

  try {
    await updateRegistrationRequestStatus(requestId, "rejected");
    request.status = "rejected";
    request.reviewedAt = new Date().toISOString();
    await loadRegistrationRequests();
    renderAll();
    setAdminNotice(`Đã từ chối đăng ký của ${request.name}.`, "ok");
  } catch (error) {
    setAdminNotice(`Không từ chối được đăng ký: ${error.message}`, "error");
  }
}

function bindTournamentManager() {
  if (!isAdmin) {
    return;
  }

  document.querySelector("#createTournamentForm")?.addEventListener("submit", createNewTournamentFromModal);
  document.querySelector("#closeCreateTournament")?.addEventListener("click", closeCreateTournamentModal);
  document.querySelector("#cancelCreateTournament")?.addEventListener("click", closeCreateTournamentModal);
  document.querySelector("#createTournamentModal")?.addEventListener("click", (event) => {
    if (event.target.id === "createTournamentModal") {
      closeCreateTournamentModal();
    }
  });
  document.querySelector("#openManualPairing")?.addEventListener("click", openManualPairingModal);
  document.querySelector("#manualPairingForm")?.addEventListener("submit", submitManualPairing);
  document.querySelector("#closeManualPairing")?.addEventListener("click", closeManualPairingModal);
  document.querySelector("#cancelManualPairing")?.addEventListener("click", closeManualPairingModal);
  document.querySelector("#manualPairingModal")?.addEventListener("click", (event) => {
    if (event.target.id === "manualPairingModal") closeManualPairingModal();
  });
  document.querySelector("#matchPairEditorForm")?.addEventListener("submit", submitMatchPairEditor);
  document.querySelector("#closeMatchPairEditor")?.addEventListener("click", closeMatchPairEditor);
  document.querySelector("#cancelMatchPairEditor")?.addEventListener("click", closeMatchPairEditor);
  document.querySelector("#matchPairEditorModal")?.addEventListener("click", (event) => {
    if (event.target.id === "matchPairEditorModal") closeMatchPairEditor();
  });
  document.querySelector("#addTournamentRound")?.addEventListener("click", openAddRoundModal);
  document.querySelector("#addEmptyTournamentRound")?.addEventListener("click", createEmptyGroupedBracketFromDetail);
  document.querySelector("#addRoundForm")?.addEventListener("submit", submitAddRound);
  document.querySelector("#closeAddRound")?.addEventListener("click", closeAddRoundModal);
  document.querySelector("#cancelAddRound")?.addEventListener("click", closeAddRoundModal);
  document.querySelector("#addRoundModal")?.addEventListener("click", (event) => {
    if (event.target.id === "addRoundModal") closeAddRoundModal();
  });

  document.querySelector("#tournamentForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.tournament.name = document.querySelector("#tournamentName").value.trim() || "Ma Buu Billiards Tournament";
    state.tournament.date = document.querySelector("#tournamentDate").value;
    state.tournament.rank = document.querySelector("#tournamentRank")?.value.trim() || "";
    state.tournament.organizer = document.querySelector("#tournamentOrganizer")?.value.trim() || "";
    state.tournament.location = document.querySelector("#tournamentLocation")?.value.trim() || "";
    state.tournament.description = document.querySelector("#tournamentDescription")?.value.trim() || "";
    saveState();
    renderAll();
    setAdminNotice("Đã lưu thông tin giải và đồng bộ lên Supabase.", "ok");
  });

  document.querySelector("#contactForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.contact = {
      name: document.querySelector("#contactName")?.value.trim() || "Ma Buu Billiards",
      address: document.querySelector("#contactAddress")?.value.trim() || "",
      phone: document.querySelector("#contactPhone")?.value.trim() || "",
      email: document.querySelector("#contactEmail")?.value.trim() || "",
      mapsUrl: document.querySelector("#contactMapsUrl")?.value.trim() || "",
      note: document.querySelector("#contactNote")?.value.trim() || "",
    };
    saveState();
    renderContact();
    setAdminNotice("Đã lưu thông tin liên hệ và đồng bộ lên Supabase.", "ok");
  });

  document.querySelector("#playerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = document.querySelector("#playerName");
    const rankInput = document.querySelector("#playerRank");
    const noteInput = document.querySelector("#playerNote");
    const rawName = nameInput.value.trim();
    const name = formatRankedPlayerName(rawName, rankInput?.value || "K");
    if (!rawName) {
      setAdminNotice("Nhập tên cơ thủ trước khi bấm thêm.", "error");
      nameInput.focus();
      return;
    }

    state.players.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      name,
      note: noteInput.value.trim(),
    });
    state.rounds = [];
    nameInput.value = "";
    if (rankInput) rankInput.value = "K";
    noteInput.value = "";
    saveState();
    renderAll();
    setAdminNotice(`Đã thêm cơ thủ ${name}.`, "ok");
  });

  document.querySelector("#seedDemoPlayers")?.addEventListener("click", () => {
    state.players = defaultPlayers.map((name, index) => ({
      id: `demo-${index + 1}`,
      name,
      note: "Hạt giống mẫu",
    }));
    state.rounds = [];
    saveState();
    renderAll();
    setAdminNotice("Đã nạp mẫu 16 cơ thủ.", "ok");
  });

  document.querySelector("#generateBracket")?.addEventListener("click", () => {
    buildBracket();
    if (state.rounds.length) {
      setAdminNotice("Đã tạo bracket. Vào tab Sơ đồ đấu để nhập điểm.", "ok");
    }
  });
  document.querySelector("#syncSchedule")?.addEventListener("click", renderSchedule);
  document.querySelector("#saveBracket")?.addEventListener("click", () => {
    saveState();
    renderAll();
  });
  document.querySelector("#resetScores")?.addEventListener("click", () => {
    if (state.tournament.format === "double" && state.rounds.some((round) => round.bracketGroup === "record" || round.bracketGroup === "record-final")) {
      const slots = state.players.slice(0, 32).map((player) => player.name);
      state.rounds = buildDiagramBracket(slots);
      recalculateDoubleBracket();
      saveState();
      renderAll();
      return;
    }
    state.rounds.forEach((round) => {
      round.matches.forEach((match, matchIndex) => {
        match.scoreA = "";
        match.scoreB = "";
        match.winner = null;
        match.status = match.playerA && match.playerB ? "pending" : "waiting";
        if (round.matches.length !== state.rounds[0].matches.length) {
          match.playerA = null;
          match.playerB = null;
        }
        match.matchIndex = matchIndex;
      });
    });
    if (state.rounds.some((round) => isRoutedBracketMatch(round.matches?.[0]))) recalculateDoubleBracket();
    else autoAdvanceByes();
    saveState();
    renderAll();
  });

  document.querySelector("#clearRankingData")?.addEventListener("click", () => {
    if (!confirm("Xóa toàn bộ dữ liệu bảng xếp hạng đã tích lũy? Giải đấu và sơ đồ hiện tại vẫn được giữ nguyên.")) return;
    const entries = [
      { id: "current", rounds: state.rounds },
      ...state.tournamentHistory.map((entry) => ({ id: entry.id, rounds: entry.rounds || [] })),
    ];
    state.playerStats = [];
    state.rankingIgnoredResults = [...new Set(entries.flatMap((entry) =>
      matchesFromRounds(entry.rounds)
        .filter((match) => match.status === "done" && match.playerA && match.playerB)
        .map((match) => rankingResultKey(entry.id, match)),
    ))];
    saveState();
    renderAll();
    setAdminNotice("Đã xóa toàn bộ dữ liệu bảng xếp hạng.", "ok");
  });

  document.querySelector("#lanCameraForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#lanCameraListInput");
    const status = document.querySelector("#lanCameraStatus");
    try {
      state.lanCameras = parseLanCameraLines(input?.value || "");
      saveState();
      renderLanCameraSettings();
      if (status) {
        status.textContent = `Đã lưu ${state.lanCameras.length} camera nội bộ.`;
        status.dataset.type = "ok";
      }
      setAdminNotice(`Đã lưu ${state.lanCameras.length} camera nội bộ.`, "ok");
    } catch (error) {
      if (status) {
        status.textContent = error.message;
        status.dataset.type = "error";
      }
      setAdminNotice(error.message, "error");
    }
  });

  document.querySelector("#appPinForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#appPinInput");
    const status = document.querySelector("#appPinStatus");
    const pin = normalizeAppPin(input?.value || "");
    if (!pin) {
      if (status) {
        status.textContent = "Mã PIN phải gồm đúng 6 chữ số.";
        status.dataset.type = "error";
      }
      setAdminNotice("Mã PIN APP chưa hợp lệ.", "error");
      return;
    }
    state.appPin = pin;
    pendingAppPin = "";
    saveState();
    renderAppPinSettings();
    if (status) {
      status.textContent = `Đã lưu mã PIN APP ${pin.length} số.`;
      status.dataset.type = "ok";
    }
    setAdminNotice("Đã lưu mã PIN APP.", "ok");
  });

  document.querySelector("#adBannerFile")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = document.querySelector("#adBannerName");
    const preview = document.querySelector("#adBannerPreview");
    if (name) name.value = file.name;
    if (preview) preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Xem trước banner" />`;
  });

  document.querySelector("#adBannerForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.querySelector("#adBannerStatus");
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    const file = document.querySelector("#adBannerFile")?.files?.[0];
    let url = state.adBanner?.url || "";
    let name = state.adBanner?.name || "";
    const enabled = Boolean(document.querySelector("#adBannerEnabled")?.checked);
    if (file && file.size > 4 * 1024 * 1024) {
      status.textContent = "Hình lớn hơn 4 MB. Hãy giảm kích thước rồi thử lại.";
      status.dataset.type = "error";
      return;
    }
    if (file && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      status.textContent = "Chỉ hỗ trợ hình JPG, PNG, WebP hoặc GIF.";
      status.dataset.type = "error";
      return;
    }
    try {
      if (file) {
        submitButton.disabled = true;
        status.textContent = `Đang tải ${file.name} lên web...`;
        status.dataset.type = "";
        const uploaded = await uploadAdBannerFile(file);
        name = uploaded.name;
        url = uploaded.url;
      }
      if (enabled && (!name || !/^https?:\/\//i.test(url))) {
        throw new Error("Hãy chọn một hình từ máy trước khi bật banner.");
      }
      state.adBanner = { enabled, name, url };
      saveState();
      document.querySelector("#adBannerFile").value = "";
      renderAdBannerSettings();
      status.textContent = enabled ? `Đã tải và bật banner ${name}.` : "Đã tắt banner quảng cáo.";
      status.dataset.type = "ok";
      setAdminNotice(enabled ? `Đã lưu banner ${name}.` : "Đã tắt banner quảng cáo.", "ok");
    } catch (error) {
      status.textContent = error.message;
      status.dataset.type = "error";
      setAdminNotice(error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelectorAll("[data-pin-key]").forEach((button) => {
    button.addEventListener("click", () => {
      if (pendingAppPin.length >= 6) return;
      pendingAppPin += button.dataset.pinKey;
      renderAppPinSettings();
    });
  });

  document.querySelectorAll("[data-pin-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.pinAction === "backspace") {
        pendingAppPin = pendingAppPin.slice(0, -1);
      }
      renderAppPinSettings();
    });
  });

  document.querySelector("#archiveTournament")?.addEventListener("click", saveTournamentToHistory);

  document.querySelector("#exportJson")?.addEventListener("click", () => {
    downloadFile("ma-buu-tournament.json", "application/json;charset=utf-8", JSON.stringify(state, null, 2));
  });

  document.querySelector("#exportCsv")?.addEventListener("click", () => {
    const csv = [
      ["Vòng", "Trận", "Bàn", "Cơ thủ A", "Cơ thủ B", "Điểm A", "Điểm B", "Trạng thái"],
      ...allMatches().map((match) => [
        match.roundTitle,
        match.matchIndex + 1,
        `Bàn ${String(match.table).padStart(2, "0")}`,
        match.playerA || "TBD",
        match.playerB || "TBD",
        match.scoreA || "",
        match.scoreB || "",
        matchStatusLabel(match.status),
      ]),
    ]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    downloadFile("ma-buu-schedule.csv", "text/csv;charset=utf-8", csv);
  });

  document.querySelector("#clearTournament")?.addEventListener("click", () => {
    if (!confirm("Xoá toàn bộ dữ liệu giải hiện tại?")) {
      return;
    }

    const fresh = createDefaultState();
    archiveTournamentPlayerStats(getCurrentTournamentEntry());
    state.tournament = fresh.tournament;
    state.players = fresh.players;
    state.registrationRequests = fresh.registrationRequests;
    state.rounds = fresh.rounds;
    saveState();
    renderAll();
  });
}

function bindRegistrationForm() {
  if (isAdmin) {
    return;
  }

  document.querySelector("#registrationForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRegistrationRequest(event.currentTarget);
  });
}

function bindCameraSelector() {
  const select = document.querySelector(".clip-form select");
  const beginInput = document.querySelector("#clipBegin");
  const endInput = document.querySelector("#clipEnd");
  const openCameraButton = document.querySelector("#openCamera");
  const playbackButtons = document.querySelectorAll(".playback-option");
  const customTime = document.querySelector("#customTime");
  const tableName = document.querySelector("#selectedTableName");
  const preview = document.querySelector("#selectedCameraPreview");
  const status = document.querySelector("#cameraStatus");
  const playbackModeTools = document.querySelector("#playbackModeTools");
  const togglePlaybackMode = document.querySelector("#togglePlaybackMode");
  const reloadPlaybackButton = document.querySelector("#reloadPlayback");
  const floatingSeekControls = document.querySelector("#floatingSeekControls");
  const seekButtons = document.querySelectorAll("[data-seek]");

  if (!select || !beginInput || !endInput || !openCameraButton || !customTime || !tableName || !preview || !status || !playbackModeTools || !togglePlaybackMode || !reloadPlaybackButton || !floatingSeekControls) {
    return;
  }
  let mobilePlaybackMode = "smooth";

  const toLocalInputValue = (date) => {
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const renderPlaceholder = (message) => {
    preview.classList.remove("live-mode", "playback-mode", "seek-mode");
    floatingSeekControls.hidden = true;
    preview.innerHTML = `<span>${escapeHtml(message)}</span>`;
    preview.append(floatingSeekControls);
  };

  const renderLiveUrl = (url) => {
    if (url.includes(".m3u8") || url.includes(".mp4")) {
      preview.innerHTML = `<video controls autoplay muted playsinline></video>`;
      const video = preview.querySelector("video");

      if (url.includes(".m3u8") && window.Hls?.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        return;
      }

      video.src = url;
      return;
    }

    preview.innerHTML = `<iframe src="${escapeHtml(url)}" title="EZVIZ camera live view" allowfullscreen></iframe>`;
  };

  const renderEzvizPlayer = (data) => {
    if (!window.EZUIKit?.EZUIKitPlayer || !data.ezopenUrl || !data.accessToken) {
      renderLiveUrl(data.liveUrl || data.ezopenUrl);
      return;
    }

    if (ezvizPlayer?.stop) {
      ezvizPlayer.stop();
    }

    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    const isSeekMode = !!data.playback && isMobile && mobilePlaybackMode === "seek";
    preview.classList.toggle("live-mode", !data.playback);
    preview.classList.toggle("playback-mode", !!data.playback);
    preview.classList.toggle("seek-mode", isSeekMode);
    preview.innerHTML = `<div id="ezvizPlayer"></div>`;
    floatingSeekControls.hidden = !data.playback;
    preview.append(floatingSeekControls);
    const width = preview.clientWidth || 960;
    const height = isSeekMode ? Math.min(Math.max(Math.round(window.innerHeight * 0.72), 390), 500) : Math.round(width * 0.5625);
    const template = data.playback ? (isMobile ? (mobilePlaybackMode === "seek" ? "pcRec" : "mobileRec") : "pcRec") : "simple";

    ezvizPlayer = new EZUIKit.EZUIKitPlayer({
      id: "ezvizPlayer",
      accessToken: data.accessToken,
      url: data.ezopenUrl,
      validCode: data.validCode || undefined,
      width,
      height,
      autoplay: true,
      template,
      fit: "contain",
      objectFit: "contain",
      env: data.apiBase ? { domain: data.apiBase } : undefined,
      handleError: (error) => {
        status.textContent = `EZVIZ player lỗi: ${JSON.stringify(error)}`;
        if (data.playback && isMobile && mobilePlaybackMode === "seek") {
          status.textContent += " Nếu không phát được, bấm Chế độ mượt.";
        }
      },
    });
  };

  const setLastMinutes = (minutes) => {
    const end = new Date();
    const begin = new Date(end.getTime() - minutes * 60 * 1000);
    endInput.value = toLocalInputValue(end);
    beginInput.value = toLocalInputValue(begin);
  };

  const shiftPlaybackWindow = (seconds) => {
    const begin = new Date(beginInput.value);
    const end = new Date(endInput.value);
    if (Number.isNaN(begin.getTime()) || Number.isNaN(end.getTime())) {
      return;
    }

    beginInput.value = toLocalInputValue(new Date(begin.getTime() + seconds * 1000));
    endInput.value = toLocalInputValue(new Date(end.getTime() + seconds * 1000));
  };

  const loadLive = async () => {
    const tableNumber = select.value.replace(/\D/g, "").padStart(2, "0");
    tableName.textContent = select.value;
    setLastMinutes(30);
    playbackModeTools.hidden = true;
    floatingSeekControls.hidden = true;
    renderPlaceholder(`${select.value} - đang mở hiện tại`);
    status.textContent = "Đang mở live EZVIZ...";

    try {
      const data = await getJson(`/api/ezviz-live?table=${tableNumber}`);

      if (!data.ok) {
        renderPlaceholder(`${select.value} - chưa mở được camera`);
        status.textContent = data.message || "Chưa nhận được camera.";
        return;
      }

      renderEzvizPlayer(data);
      status.textContent = `${select.value} đang xem trực tiếp.`;
    } catch (error) {
      renderPlaceholder(`${select.value} - chưa mở được camera`);
      status.textContent = `Không gọi được camera: ${error.message}`;
    }
  };

  const loadPlayback = async (minutes) => {
    const tableNumber = select.value.replace(/\D/g, "").padStart(2, "0");
    tableName.textContent = select.value;

    if (minutes) {
      setLastMinutes(minutes);
    }

    renderPlaceholder(`${select.value} - đang mở xem lại`);
    status.textContent = "Đang gọi playback EZVIZ...";

    try {
      const params = new URLSearchParams({
        table: tableNumber,
        begin: beginInput.value,
        end: endInput.value,
      });
      const data = await getJson(`/api/ezviz-playback?${params.toString()}`);

      if (!data.ok) {
        renderPlaceholder(`${select.value} - chưa mở được xem lại`);
        status.textContent = data.message || "Chưa nhận được playback.";
        return;
      }

      data.playback = true;
      renderEzvizPlayer(data);
      playbackModeTools.hidden = false;
      togglePlaybackMode.textContent = mobilePlaybackMode === "seek" ? "Chế độ mượt" : "Thanh tua gốc";
      status.textContent = mobilePlaybackMode === "seek"
        ? `${select.value} đang xem lại. Nếu hình bị kéo, bấm Chế độ mượt.`
        : `${select.value} đang xem lại. Dùng nút -30s hoặc +30s để tua.`;
    } catch (error) {
      renderPlaceholder(`${select.value} - chưa mở được xem lại`);
      status.textContent = `Không gọi được playback: ${error.message}`;
    }
  };

  window.openTournamentCameraTable = (table, matchLabel = "") => {
    const tableNumber = String(table || 1).replace(/\D/g, "").padStart(2, "0");
    openTournamentLiveWindow(tableNumber, matchLabel);
    return;
    select.value = `Bàn ${tableNumber}`;
    tableName.textContent = select.value;
    playbackModeTools.hidden = true;
    floatingSeekControls.hidden = true;
    document.querySelector('[data-tab="camera"]')?.click();
    loadLive();
  };

  openCameraButton.addEventListener("click", loadLive);
  playbackButtons.forEach((button) => {
    button.addEventListener("click", () => {
      playbackButtons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      customTime.hidden = !button.dataset.custom;
      const minutes = button.dataset.custom ? null : Number(button.dataset.minutes);
      loadPlayback(minutes);
    });
  });
  togglePlaybackMode.addEventListener("click", () => {
    mobilePlaybackMode = mobilePlaybackMode === "seek" ? "smooth" : "seek";
    togglePlaybackMode.textContent = mobilePlaybackMode === "seek" ? "Chế độ mượt" : "Thanh tua gốc";
    loadPlayback();
  });
  reloadPlaybackButton.addEventListener("click", () => loadPlayback());
  seekButtons.forEach((button) => {
    button.addEventListener("click", () => {
      shiftPlaybackWindow(Number(button.dataset.seek));
      loadPlayback();
    });
  });
  select.addEventListener("input", () => {
    tableName.textContent = select.value;
    playbackModeTools.hidden = true;
    renderPlaceholder(`${select.value} - bấm Live hoặc chọn xem lại`);
    status.textContent = "Chưa mở camera.";
  });
  renderPlaceholder("Chọn bàn rồi bấm Live");
  setLastMinutes(30);
}

bindTabs();
bindBracketFit();
bindMiniGame();
bindTournamentManager();
bindRegistrationForm();
bindCameraSelector();
document.addEventListener("focusin", markLocalEdit);
document.addEventListener("input", markLocalEdit);
document.addEventListener("change", markLocalEdit);
document.querySelector("#homePlayerSearch")?.addEventListener("input", (event) => {
  renderHomePlayerList(event.target.value);
});

if (isAdmin) {
  initAdminAuth();
} else {
  renderAll();
  loadCloudState();
  startCloudAutoRefresh();
}
