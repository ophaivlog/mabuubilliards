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

function createDefaultState() {
  return {
    tournament: {
      name: "Ma Buu Billiards Tournament",
      date: new Date().toISOString().slice(0, 10),
      format: "single",
    },
    players: [],
    playerStats: [],
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

  if (!Array.isArray(target.registrationRequests)) {
    target.registrationRequests = [];
  }

  if (!Array.isArray(target.tournamentHistory)) {
    target.tournamentHistory = [];
  }

  if (!Array.isArray(target.rounds)) {
    target.rounds = [];
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
  state.tournamentHistory = Array.isArray(remoteState.tournamentHistory) ? remoteState.tournamentHistory : [];
  state.rounds = Array.isArray(remoteState.rounds) ? remoteState.rounds : [];
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
    name: player.querySelector(".player-name")?.textContent.trim() || "TBD",
    score: player.querySelector(".score-input")?.value || player.querySelector(".score")?.textContent.trim() || "-",
    winner: player.classList.contains("winner"),
  }));

  return {
    label: matchCard.dataset.matchLabel || "",
    table: matchCard.dataset.openMatchCamera,
    status: matchCard.querySelector(".status")?.textContent.trim() || "",
    playerA: players[0]?.name || "TBD",
    scoreA: players[0]?.score || "-",
    playerB: players[1]?.name || "TBD",
    scoreB: players[1]?.score || "-",
    winnerA: !!players[0]?.winner,
    winnerB: !!players[1]?.winner,
  };
}

function canOpenMatchLive(matchInfo = {}) {
  const hasPlayers = matchInfo.playerA && matchInfo.playerA !== "TBD" && matchInfo.playerB && matchInfo.playerB !== "TBD";
  return hasPlayers && matchInfo.status !== "Kết thúc";
}

function renderTournamentLiveScore(modal, matchInfo = {}) {
  const score = modal.querySelector("#tournamentLiveScore");
  const playerA = escapeHtml(matchInfo.playerA || "TBD");
  const playerB = escapeHtml(matchInfo.playerB || "TBD");
  const scoreA = escapeHtml(matchInfo.scoreA || "-");
  const scoreB = escapeHtml(matchInfo.scoreB || "-");
  const status = escapeHtml(matchInfo.status || "Dang thi dau");

  score.innerHTML = `
    <div class="live-score-player${matchInfo.winnerA ? " winner" : ""}">
      <strong>${playerA}</strong>
      <span>${scoreA}</span>
    </div>
    <div class="live-score-divider">vs</div>
    <div class="live-score-player${matchInfo.winnerB ? " winner" : ""}">
      <strong>${playerB}</strong>
      <span>${scoreB}</span>
    </div>
    <small>${status}</small>
  `;
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

  if (state.rounds.length && !confirm("Chia lại sơ đồ đấu sẽ xoá điểm và kết quả hiện tại. Tiếp tục?")) {
    return;
  }

  const bracketPlayers = randomize ? shuffledItems(state.players) : state.players;
  const size = nextPowerOfTwo(bracketPlayers.length);
  const titles = roundTitles(size);
  const slots = [...bracketPlayers.map((player) => player.name)];
  while (slots.length < size) {
    slots.push(null);
  }

  state.rounds = titles.map((title, roundIndex) => ({
    title,
    matches: Array.from({ length: size / 2 ** (roundIndex + 1) }, (_, matchIndex) => {
      if (roundIndex === 0) {
        return makeMatch(roundIndex, matchIndex, slots[matchIndex * 2], slots[matchIndex * 2 + 1]);
      }

      return makeMatch(roundIndex, matchIndex);
    }),
  }));

  autoAdvanceByes();
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

function updateMatchScore(roundIndex, matchIndex, field, value) {
  if (!isAdmin) {
    return;
  }

  const match = state.rounds[roundIndex]?.matches[matchIndex];
  if (!match) {
    return;
  }

  match[field] = value;
  const scoreA = Number(match.scoreA);
  const scoreB = Number(match.scoreB);
  clearDownstream(roundIndex, matchIndex);

  if (match.playerA && match.playerB && Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB) {
    match.winner = scoreA > scoreB ? match.playerA : match.playerB;
    match.status = "done";
    advanceWinner(match);
  } else {
    match.winner = null;
    match.status = match.playerA && match.playerB ? "pending" : "waiting";
  }

  saveState();
  renderAll();
}

function playerRow(name, score, winner, roundIndex, matchIndex, field) {
  const disabled = !name ? "disabled" : "";
  const scoreMarkup = isAdmin
    ? `<input class="score-input" ${disabled} data-round="${roundIndex}" data-match="${matchIndex}" data-field="${field}" value="${escapeHtml(score)}" inputmode="numeric" aria-label="Điểm ${escapeHtml(name || "")}" />`
    : `<span class="score score-display">${escapeHtml(score || "-")}</span>`;

  return `
    <div class="player ${winner ? "winner" : ""}">
      <span class="flag">★</span>
      <span class="avatar" aria-hidden="true"></span>
      <span class="name">${escapeHtml(name || "Chờ xác định")}</span>
      ${scoreMarkup}
    </div>
  `;
}

function matchPosition(roundIndex, matchIndex) {
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

function renderBracket() {
  const canvas = document.querySelector("#bracketCanvas");
  const title = document.querySelector("#bracketTitle");
  if (!canvas) {
    return;
  }

  canvas.innerHTML = "";
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

  canvas.style.minWidth = `${state.rounds.length * cardWidth + (state.rounds.length - 1) * gapX}px`;
  canvas.style.height = `${Math.max(540, topOffset + rowHeight * state.rounds[0].matches.length + 90)}px`;

  state.rounds.forEach((round, roundIndex) => {
    const roundTitle = document.createElement("div");
    roundTitle.className = "round-title";
    roundTitle.textContent = round.title;
    roundTitle.style.left = `${roundIndex * (cardWidth + gapX)}px`;
    canvas.append(roundTitle);

    round.matches.forEach((match, matchIndex) => {
      const pos = matchPosition(roundIndex, matchIndex);
      const isLiveMatch = match.playerA && match.playerB && match.status !== "done";
      const el = document.createElement("article");
      el.className = "match";
      el.dataset.openMatchCamera = Number(match.table) || matchIndex + 1;
      el.dataset.matchLabel = `Tran ${match.matchIndex + 1}`;
      el.dataset.matchLive = isLiveMatch ? "true" : "false";
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      el.innerHTML = `
        <div class="match-meta">
          <span>${match.time || `Bàn ${String(match.table).padStart(2, "0")}`}</span>
          <button class="match-camera" data-open-match-camera="${Number(match.table) || matchIndex + 1}" type="button" ${isLiveMatch ? "" : "disabled"} title="${isLiveMatch ? "Mo camera EZVIZ" : "Chi mo camera khi tran dang dien ra"}">EZVIZ</button>
          <span class="status">${match.status === "done" ? "Kết thúc" : "Chưa đấu"}</span>
        </div>
        <div class="match-body">
          ${playerRow(match.playerA, match.scoreA, match.winner === match.playerA, roundIndex, matchIndex, "scoreA")}
          ${playerRow(match.playerB, match.scoreB, match.winner === match.playerB, roundIndex, matchIndex, "scoreB")}
        </div>
      `;
      canvas.append(el);

      if (roundIndex < state.rounds.length - 1) {
        const next = matchPosition(roundIndex + 1, Math.floor(matchIndex / 2));
        const startX = pos.x + cardWidth;
        const midX = startX + gapX / 2;
        const endX = pos.x + cardWidth + gapX;
        const y1 = pos.centerY;
        const y2 = next.centerY;

        canvas.append(line("horizontal", startX, y1, midX - startX, 1));
        canvas.append(line("vertical", midX, Math.min(y1, y2), 1, Math.abs(y2 - y1)));
        canvas.append(line("horizontal", midX, y2, endX - midX, 1));
      }
    });
  });

  canvas.querySelectorAll(".match[data-open-match-camera]").forEach((matchCard) => {
    matchCard.addEventListener("click", (event) => {
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

  if (!isAdmin) {
    return;
  }

  canvas.querySelectorAll(".score-input").forEach((input) => {
    input.addEventListener("change", () => {
      updateMatchScore(Number(input.dataset.round), Number(input.dataset.match), input.dataset.field, input.value.trim());
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
              <option value="double"${tournament.format === "double" ? " selected" : ""}>Loại kép</option>
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
      <article><small>Thể thức</small><strong>${escapeHtml(tournament.format || "single")}</strong></article>
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
                    <small>Bàn ${String(match.table).padStart(2, "0")} • ${escapeHtml(match.scoreA || "-")} - ${escapeHtml(match.scoreB || "-")} • ${
                      match.status === "done" ? "Kết thúc" : "Chưa đấu"
                    }</small>
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
                (round) => `
                  <section class="bracket-stage">
                    <h4>${escapeHtml(round.title)}</h4>
                    ${(round.matches || [])
                      .map(
                        (match) => {
                          const aWon = match.winner && match.winner === match.playerA;
                          const bWon = match.winner && match.winner === match.playerB;
                          const isLiveMatch = match.playerA && match.playerB && match.status !== "done";
                          return `
                          <button class="bracket-mini-match${match.status === "done" ? " done" : ""}" data-open-match-camera="${Number(match.table) || match.matchIndex + 1}" type="button" ${isLiveMatch ? "" : "disabled"}>
                            <span class="sr-only" data-live-match-info
                              data-label="Trận ${match.matchIndex + 1}"
                              data-status="${match.status === "done" ? "Kết thúc" : "Chưa đấu"}"
                              data-player-a="${escapeHtml(match.playerA || "TBD")}"
                              data-score-a="${escapeHtml(match.scoreA || "-")}"
                              data-player-b="${escapeHtml(match.playerB || "TBD")}"
                              data-score-b="${escapeHtml(match.scoreB || "-")}"
                              data-winner-a="${aWon ? "true" : "false"}"
                              data-winner-b="${bWon ? "true" : "false"}"></span>
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
        playerA: liveInfo.dataset.playerA || "TBD",
        scoreA: liveInfo.dataset.scoreA || "-",
        playerB: liveInfo.dataset.playerB || "TBD",
        scoreB: liveInfo.dataset.scoreB || "-",
        winnerA: liveInfo.dataset.winnerA === "true",
        winnerB: liveInfo.dataset.winnerB === "true",
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
  const name = form.elements.name.value.trim();

  if (!name) {
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
  const name = form.elements.name.value.trim();
  const phone = form.elements.phone.value.trim();
  const note = form.elements.note.value.trim();

  if (!name || !phone) {
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
    <article><small>Thể thức</small><strong>Loại trực tiếp</strong></article>
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
  const liveMatches = matches.filter((match) => match.playerA && match.playerB && match.status !== "done").length;
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
                                match.status === "done" ? "Kết thúc" : "Chưa đấu"
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
  (entry.players || []).forEach((player) => addRankingPlayer(rows, player.name, tournamentId));
  matchesFromRounds(entry.rounds)
    .filter((match) => match.playerA || match.playerB)
    .forEach((match) => {
      addRankingPlayer(rows, match.playerA, tournamentId);
      addRankingPlayer(rows, match.playerB, tournamentId);
    });

  matchesFromRounds(entry.rounds)
    .filter((match) => match.status === "done" && match.playerA && match.playerB)
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

  (state.playerStats || []).forEach((record) => mergeRankingRecord(rows, record));

  entries.forEach((entry) => {
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
      .filter((match) => match.status === "done" && match.playerA && match.playerB)
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
          <td>${match.status === "done" ? "Kết thúc" : "Chưa đấu"}</td>
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
  const phoneInput = form.querySelector("#registrationPhone");
  const noteInput = form.querySelector("#registrationNote");
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!name || !phone) {
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
    const noteInput = document.querySelector("#playerNote");
    const name = nameInput.value.trim();
    if (!name) {
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
    autoAdvanceByes();
    saveState();
    renderAll();
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
        match.status === "done" ? "Kết thúc" : "Chưa đấu",
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
