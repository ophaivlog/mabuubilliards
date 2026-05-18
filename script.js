const rounds = [
  {
    title: "Vòng 1/16",
    matches: [],
  },
  {
    title: "Vòng 1/8",
    matches: [],
  },
  {
    title: "Tứ kết",
    matches: [],
  },
  {
    title: "Bán kết",
    matches: [],
  },
  {
    title: "Chung kết",
    matches: [],
  },
];

const cardWidth = 320;
const cardHeight = 102;
const rowHeight = 122;
const gapX = 76;
const topOffset = 70;
const tableCount = 14;
let ezvizPlayer = null;

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

function playerRow(name, score, winner) {
  return `
    <div class="player ${winner ? "winner" : ""}">
      <span class="flag">★</span>
      <span class="avatar" aria-hidden="true"></span>
      <span class="name">${name}</span>
      <span class="score">${score}</span>
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
  canvas.innerHTML = "";

  rounds.forEach((round, roundIndex) => {
    const title = document.createElement("div");
    title.className = "round-title";
    title.textContent = round.title;
    title.style.left = `${roundIndex * (cardWidth + gapX)}px`;
    canvas.append(title);

    round.matches.forEach((match, matchIndex) => {
      const [time, playerA, scoreA, playerB, scoreB] = match;
      const pos = matchPosition(roundIndex, matchIndex);
      const el = document.createElement("article");
      el.className = "match";
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      el.innerHTML = `
        <div class="match-meta">
          <span>${time}</span>
          <span class="status">Kết thúc</span>
        </div>
        <div class="match-body">
          ${playerRow(playerA, scoreA, scoreA > scoreB)}
          ${playerRow(playerB, scoreB, scoreB > scoreA)}
        </div>
      `;
      canvas.append(el);

      if (roundIndex < rounds.length - 1) {
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

  if (!rounds.some((round) => round.matches.length > 0)) {
    const empty = document.createElement("div");
    empty.className = "raw-bracket-note";
    empty.textContent = "Chưa có dữ liệu thi đấu";
    canvas.append(empty);
  }
}

function bindTabs() {
  const buttons = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((item) => item.classList.remove("active"));
      panels.forEach((panel) => {
        panel.hidden = panel.id !== button.dataset.tab;
      });
      button.classList.add("active");
    });
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

  if (!select || !beginInput || !endInput || !openCameraButton || !customTime || !tableName || !preview || !status) {
    return;
  }

  const toLocalInputValue = (date) => {
    const pad = (number) => String(number).padStart(2, "0");

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const now = new Date();
  endInput.value = toLocalInputValue(now);
  beginInput.value = toLocalInputValue(new Date(now.getTime() - 15 * 60 * 1000));

  const renderPlaceholder = (message) => {
    preview.classList.remove("live-mode", "playback-mode");
    preview.innerHTML = `<span>${message}</span>`;
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

    preview.innerHTML = `<iframe src="${url}" title="EZVIZ camera live view" allowfullscreen></iframe>`;
  };

  const renderEzvizPlayer = (data) => {
    if (!window.EZUIKit?.EZUIKitPlayer || !data.ezopenUrl || !data.accessToken) {
      renderLiveUrl(data.liveUrl);
      return;
    }

    if (ezvizPlayer?.stop) {
      ezvizPlayer.stop();
    }

    preview.classList.toggle("live-mode", !data.playback);
    preview.classList.toggle("playback-mode", !!data.playback);
    preview.innerHTML = `<div id="ezvizPlayer"></div>`;
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    const width = preview.clientWidth || 960;
    const height = Math.round(width * 0.5625);
    const template = data.playback
      ? isMobile
        ? "mobileRec"
        : "pcRec"
      : isMobile
        ? "mobileLive"
        : "pcLive";

    ezvizPlayer = new EZUIKit.EZUIKitPlayer({
      id: "ezvizPlayer",
      accessToken: data.accessToken,
      url: data.ezopenUrl,
      validCode: data.validCode || undefined,
      width,
      height,
      autoplay: true,
      template,
      env: data.apiBase ? { domain: data.apiBase } : undefined,
      handleError: (error) => {
        status.textContent = `EZVIZ player lỗi: ${JSON.stringify(error)}`;
      },
    });
  };

  const setLast30Minutes = () => {
    const end = new Date();
    const begin = new Date(end.getTime() - 30 * 60 * 1000);
    endInput.value = toLocalInputValue(end);
    beginInput.value = toLocalInputValue(begin);
  };

  const setLastMinutes = (minutes) => {
    const end = new Date();
    const begin = new Date(end.getTime() - minutes * 60 * 1000);
    endInput.value = toLocalInputValue(end);
    beginInput.value = toLocalInputValue(begin);
  };

  const loadLive = async () => {
    const tableNumber = select.value.replace(/\D/g, "").padStart(2, "0");
    tableName.textContent = select.value;
    setLast30Minutes();
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
      status.textContent = `${select.value} đang xem lại. Có thể tua trên thanh thời gian.`;
    } catch (error) {
      renderPlaceholder(`${select.value} - chưa mở được xem lại`);
      status.textContent = `Không gọi được playback: ${error.message}`;
    }
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
  select.addEventListener("input", () => {
    tableName.textContent = select.value;
    renderPlaceholder(`${select.value} - bấm Xem`);
    status.textContent = "Chưa mở playback.";
  });
  renderPlaceholder("Chọn bàn rồi bấm Xem");
  setLast30Minutes();
}

renderBracket();
bindTabs();
bindCameraSelector();
