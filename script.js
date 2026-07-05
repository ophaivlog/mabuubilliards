const STORAGE_KEY = "maBuuTournament.v1";
const cardWidth = 320;
const cardHeight = 128;
const rowHeight = 148;
const gapX = 76;
const topOffset = 70;
const tableCount = 14;
let ezvizPlayer = null;
let tournamentLivePlayer = null;
const isAdmin = document.body?.dataset.mode === "admin";
let supabaseClient = null;
let cloudSaveTimer = null;
let lastLocalEditAt = 0;
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
let bracketFitMode = false;
let bracketManualScale = 1;
let bracketResizeObserver = null;

function createDefaultState() {
  return {
    tournament: {
      name: "Ma Buu Billiards Tournament",
      date: new Date().toISOString().slice(0, 10),
      format: "single",
    },
    players: [],
    playerStats: [],
    rankingIgnoredResults: [],
    registrationRequests: [],
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
  if (!Array.isArray(target.players)) {
    target.players = [];
  }

  if (!Array.isArray(target.playerStats)) {
    target.playerStats = [];
  }
  if (!Array.isArray(target.rankingIgnoredResults)) {
    target.rankingIgnoredResults = [];
  }

  if (!Array.isArray(target.registrationRequests)) {
    target.registrationRequests = [];
  }

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

async function unlockAdmin() {
  document.body.dataset.auth = "unlocked";
  setLoginStatus("Đã đăng nhập.", "ok");
  renderAll();
  await loadCloudState();
  await loadRegistrationRequests();
  if (!isTypingInEditableField()) {
    renderAll();
  }
}

function lockAdmin() {
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

    const { error } = await client.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });

    if (error) {
      setLoginStatus(`Không đăng nhập được: ${error.message}`, "error");
      return;
    }

    passwordInput.value = "";
    await unlockAdmin();
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

  const { data } = await client.auth.getSession();
  if (data?.session) {
    await unlockAdmin();
  } else {
    lockAdmin();
  }

  client.auth.onAuthStateChange((_event, session) => {
    if (session) {
      unlockAdmin();
    } else {
      lockAdmin();
    }
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
      match.playerA = match.seedA || null;
      match.playerB = match.seedB || null;
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
        if (route && player) state.rounds[route.round].matches[route.match][route.slot] = player;
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

  if (state.players.length > 32) {
    alert("Bản cơ bản hiện hỗ trợ tối đa 32 cơ thủ.");
    return;
  }
  if (state.tournament.format === "double" && ![16, 24, 32].includes(state.players.length)) {
    alert("Sơ đồ đối xứng hỗ trợ 16, 24 hoặc 32 cơ thủ.");
    return;
  }

  if (state.rounds.length && !confirm("Chia lại sơ đồ đấu sẽ xoá điểm và kết quả hiện tại. Tiếp tục?")) {
    return;
  }

  const bracketPlayers = randomize ? shuffledItems(state.players) : state.players;
  const size = nextPowerOfTwo(bracketPlayers.length);
  const titles = roundTitles(size);
  let slots = [...bracketPlayers.map((player) => player.name)];
  if (state.tournament.format !== "double") while (slots.length < size) slots.push(null);

  state.rounds = state.tournament.format === "double"
    ? buildDiagramBracket(slots)
    : titles.map((title, roundIndex) => ({
    title,
    matches: Array.from({ length: size / 2 ** (roundIndex + 1) }, (_, matchIndex) => {
      if (roundIndex === 0) {
        return makeMatch(roundIndex, matchIndex, slots[matchIndex * 2], slots[matchIndex * 2 + 1]);
      }

      return makeMatch(roundIndex, matchIndex);
    }),
  }));

  if (state.tournament.format === "double") recalculateDoubleBracket();
  else autoAdvanceByes();
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

function updateMatchScore(roundIndex, matchIndex, field, value) {
  if (!isAdmin) {
    return;
  }

  const match = state.rounds[roundIndex]?.matches[matchIndex];
  if (!match) {
    return;
  }

  match[field] = value;
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
    return;
  }
  if (isRoutedBracketMatch(match)) {
    recalculateDoubleBracket();
    saveState();
    renderAll();
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
  if (match.bracketGroup === "record" || match.bracketGroup === "record-final") {
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

function renderBracket() {
  const canvas = document.querySelector("#bracketCanvas");
  const title = document.querySelector("#bracketTitle");
  if (!canvas) {
    return;
  }

  canvas.innerHTML = "";
  canvas.style.zoom = "1";
  title.textContent = state.tournament.name || "Ma Buu Billiards Tournament";
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
  const layout = isDoubleBracket ? doubleBracketLayout() : null;
  const diagramLayout = isDiagramBracket ? diagramBracketLayout() : null;
  canvas.classList.toggle("double-bracket", isDoubleBracket);
  canvas.classList.toggle("record-bracket", isRecordBracket);
  canvas.classList.toggle("diagram-bracket", isDiagramBracket);
  canvas.style.minWidth = isDiagramBracket
    ? `${diagramLayout.columns * diagramLayout.stepX + cardWidth}px`
    : isDoubleBracket
    ? `${(layout.finalColumn + 2) * layout.stepX + cardWidth}px`
    : `${state.rounds.length * cardWidth + (state.rounds.length - 1) * gapX}px`;
  const doubleHeight = isDoubleBracket ? layout.loserTop + layout.loserHeight + 110 : 0;
  const recordHeight = isRecordBracket
    ? topOffset + Math.max(...state.rounds.map((round) => round.matches.length)) * (cardHeight + 30) + 70
    : 0;
  canvas.style.height = `${Math.max(540, doubleHeight, recordHeight, diagramLayout?.height || 0, topOffset + rowHeight * state.rounds[0].matches.length + 90)}px`;

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

  state.rounds.forEach((round, roundIndex) => {
    const roundTitle = document.createElement("div");
    roundTitle.className = "round-title";
    roundTitle.textContent = round.title.replace(/^Nhánh (thắng|thua) • /i, "");
    const titlePos = matchPosition(roundIndex, 0);
    roundTitle.style.left = `${titlePos.x}px`;
    if (round.bracketGroup === "loser") roundTitle.style.top = `${layout.loserTop - 30}px`;
    if (round.bracketGroup === "final") roundTitle.style.top = "18px";
    if (round.bracketGroup === "record" || round.bracketGroup === "record-final") roundTitle.style.top = "54px";
    if (round.bracketGroup === "diagram-loser") roundTitle.style.top = `${diagramLayout.loserTop - 42}px`;
    if (round.bracketGroup === "diagram-grand") roundTitle.style.top = `${titlePos.y - 48}px`;
    canvas.append(roundTitle);

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
      el.innerHTML = `
        <div class="match-meta">
          <span>${match.time || `Bàn ${String(match.table).padStart(2, "0")}`}</span>
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
  const buttons = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  const activate = (tabName, options = {}) => {
    buttons.forEach((button) => button.classList.toggle("active", button.dataset.tab === tabName));
    panels.forEach((panel) => {
      panel.hidden = panel.id !== tabName;
    });
    if (tabName === "bracket") {
      requestAnimationFrame(() => requestAnimationFrame(applyBracketScale));
    }
    if (isAdmin && tabName === "requests") {
      loadRegistrationRequests().then(renderAll);
    }
    if (tabName === "tournaments") {
      renderTournamentDirectory();
    }
    if (options.focusTournamentName) {
      document.querySelector("#tournamentName")?.focus();
    }
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.tab));
  });

  document.querySelectorAll("[data-home-tab]").forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.homeTab));
  });

  document.querySelector("#quickCreateTournament")?.addEventListener("click", () => {
    if (isAdmin) {
      openCreateTournamentModal();
      return;
    }
    activate("tournaments");
  });
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
            Thể thức
            <select name="format">
              <option value="single"${(tournament.format || "single") === "single" ? " selected" : ""}>Loại trực tiếp</option>
              <option value="double"${tournament.format === "double" ? " selected" : ""}>Sơ đồ 2 mạng đối xứng (16/24/32 cơ thủ)</option>
              <option value="round-robin"${tournament.format === "round-robin" ? " selected" : ""}>Vòng tròn</option>
            </select>
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
      <article><small>Thể thức</small><strong>${tournament.format === "double" ? "Sơ đồ 2 mạng đối xứng" : "Loại trực tiếp"}</strong></article>
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

function renderDetailBracket(entry) {
  const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
  const players = Array.isArray(entry.players) ? entry.players : [];
  const canManageBracket = isAdmin && entry.isCurrent;

  return `
    ${
      canManageBracket
        ? `
          <div class="data-section wide-section inline-section bracket-draw-panel">
            <div class="section-heading">
              <div>
                <p>DANH SÁCH CƠ THỦ</p>
                <h2>${players.length} cơ thủ đã đăng ký</h2>
              </div>
              <button class="primary-action" data-randomize-bracket type="button">Chia bảng ngẫu nhiên</button>
            </div>
            <div class="registered-player-grid">
              ${
                players.length
                  ? players.map((player, index) => `<span>${index + 1}. ${escapeHtml(player.name)}</span>`).join("")
                  : `<span>Chưa có cơ thủ đã đăng ký</span>`
              }
            </div>
          </div>
        `
        : ""
    }
    <div class="history-rounds detail-rounds">
      ${
        rounds.length
          ? rounds
              .map(
                (round, roundIndex) => `
                  <section class="bracket-stage">
                    <h4>${escapeHtml(round.title)}</h4>
                    ${(round.matches || [])
                      .map(
                        (match) => {
                          const aWon = match.winner && match.winner === match.playerA;
                          const bWon = match.winner && match.winner === match.playerB;
                          const isLiveMatch = match.playerA && match.playerB && match.status === "live";
                          return `
                          <button class="bracket-mini-match${match.status === "done" ? " done" : ""}" data-open-match-camera="${Number(match.table) || match.matchIndex + 1}" type="button" ${isLiveMatch ? "" : "disabled"}>
                            <span class="sr-only" data-live-match-info
                              data-label="Trận ${match.matchIndex + 1}"
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
                              <span>Trận ${match.matchIndex + 1}</span>
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
                        },
                      )
                      .join("")}
                  </section>
                `,
              )
              .join("")
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
      renderTournamentDirectory();
    });
  });

  const selectedEntry = entries.find((entry) => entry.id === selectedTournamentId) || entries[0];
  const detailTabs = isAdmin
    ? [
        ["info", "Thông tin"],
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

  reader.querySelector("#directoryTournamentForm")?.addEventListener("submit", submitDirectoryTournamentForm);
  reader.querySelector("#directoryPlayerForm")?.addEventListener("submit", submitDirectoryPlayerForm);
  reader.querySelector("#directoryRegistrationForm")?.addEventListener("submit", submitDirectoryRegistrationRequest);
  reader.querySelector("[data-delete-tournament]")?.addEventListener("click", deleteSelectedTournament);
  reader.querySelector("[data-randomize-bracket]")?.addEventListener("click", () => {
    buildBracket(true);
    selectedTournamentDetailTab = "bracket";
    if (state.rounds.length) {
      setAdminNotice("Đã chia bảng đấu ngẫu nhiên.", "ok");
    }
  });
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

function submitDirectoryTournamentForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim() || "Ma Buu Billiards Tournament";
  const date = form.elements.date.value;
  const format = form.elements.format.value;

  if (selectedTournamentId === "current") {
    state.tournament.name = name;
    state.tournament.date = date;
    state.tournament.format = format;
  } else {
    const entry = state.tournamentHistory.find((item) => item.id === selectedTournamentId);
    if (entry) {
      entry.tournament = {
        ...(entry.tournament || {}),
        name,
        date,
        format,
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
  const formatInput = document.querySelector("#tournamentFormat");
  const cards = document.querySelector("#overviewCards");

  if (!nameInput || !dateInput || !formatInput || !cards) {
    return;
  }

  nameInput.value = state.tournament.name || "";
  dateInput.value = state.tournament.date || "";
  formatInput.value = state.tournament.format || "single";

  const doneMatches = state.rounds.flatMap((round) => round.matches).filter((match) => match.status === "done").length;
  const totalMatches = state.rounds.flatMap((round) => round.matches).length;
  cards.innerHTML = `
    <article><small>Tên giải</small><strong>${escapeHtml(state.tournament.name || "Chưa thiết lập")}</strong></article>
    <article><small>Ngày thi đấu</small><strong>${escapeHtml(state.tournament.date || "Chưa chọn")}</strong></article>
    <article><small>Cơ thủ</small><strong>${state.players.length}</strong></article>
    <article><small>Trận đã xong</small><strong>${doneMatches}/${totalMatches || 0}</strong></article>
    <article><small>Thể thức</small><strong>${state.tournament.format === "double" ? "Sơ đồ 2 mạng đối xứng" : "Loại trực tiếp"}</strong></article>
    <article><small>Trạng thái</small><strong>${totalMatches && doneMatches === totalMatches ? "Hoàn tất" : "Đang diễn ra"}</strong></article>
  `;
}

function renderHome() {
  const title = document.querySelector("#homeTournamentName");
  const meta = document.querySelector("#homeTournamentMeta");
  const stats = document.querySelector("#homeStats");

  if (!title || !meta || !stats) {
    return;
  }

  const matches = allMatches();
  const doneMatches = matches.filter((match) => match.status === "done").length;
  const liveMatches = matches.filter((match) => match.playerA && match.playerB && match.status === "live").length;
  const waitingMatches = matches.length - doneMatches - liveMatches;
  const status = matches.length && doneMatches === matches.length ? "Hoàn tất" : "Đang diễn ra";

  title.textContent = state.tournament.name || "Ma Buu Billiards Tournament";
  meta.textContent = `${state.tournament.date || "Chưa chọn ngày"} • ${state.players.length} cơ thủ • ${matches.length} trận`;
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

  return [...rows.values()].map((row) => ({
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
          (row, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${escapeHtml(row.name)}</td>
              <td>${row.played}</td>
              <td>${row.won}</td>
              <td>${row.lost}</td>
              <td>${row.winRate}% • ${row.tournamentCount} giải</td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td colspan="6">Chưa có dữ liệu xếp hạng.</td></tr>`;
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
  renderHistory();
  renderDownload();
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
  const formatInput = document.querySelector("#newTournamentFormat");

  if (!modal || !nameInput || !dateInput || !formatInput) {
    document.querySelector("#tournamentName")?.focus();
    return;
  }

  nameInput.value = "";
  dateInput.value = new Date().toISOString().slice(0, 10);
  formatInput.value = "single";
  modal.hidden = false;
  nameInput.focus();
}

function closeCreateTournamentModal() {
  const modal = document.querySelector("#createTournamentModal");
  if (modal) {
    modal.hidden = true;
  }
}

function createNewTournamentFromModal(event) {
  event.preventDefault();
  const nameInput = document.querySelector("#newTournamentName");
  const dateInput = document.querySelector("#newTournamentDate");
  const formatInput = document.querySelector("#newTournamentFormat");
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
    name,
    date: dateInput?.value || new Date().toISOString().slice(0, 10),
    format: formatInput?.value || "single",
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

  document.querySelector("#tournamentForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.tournament.name = document.querySelector("#tournamentName").value.trim() || "Ma Buu Billiards Tournament";
    state.tournament.date = document.querySelector("#tournamentDate").value;
    state.tournament.format = document.querySelector("#tournamentFormat").value;
    saveState();
    renderAll();
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

if (isAdmin) {
  initAdminAuth();
} else {
  renderAll();
  loadCloudState();
  startCloudAutoRefresh();
}
