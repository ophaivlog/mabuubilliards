const DEFAULT_TOKEN_PATH = "/api/lapp/token/get";
const DEFAULT_LIVE_PATH = "/api/lapp/v2/live/address/get";
const DEFAULT_DEVICE_LIST_PATH = "/api/lapp/device/list";
const DEFAULT_EZOPEN_DOMAIN = "open.ys7.com";
const tokenCache = {
  accessToken: null,
  expireAt: 0,
};

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getCameraMap() {
  if (!process.env.EZVIZ_CAMERA_MAP) {
    return {};
  }

  try {
    return JSON.parse(process.env.EZVIZ_CAMERA_MAP);
  } catch (error) {
    return {};
  }
}

async function postForm(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(payload),
  });

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    return { code: String(response.status), msg: text };
  }
}

async function validateHlsUrl(url) {
  if (!url || !url.includes(".m3u8")) {
    return { ok: true };
  }

  const response = await fetch(url);
  const playlist = await response.text();
  const errorMatch = playlist.match(/ErrCode\/([^_\s/]+)_/);

  if (errorMatch) {
    return {
      ok: false,
      code: errorMatch[1],
      playlist,
    };
  }

  return { ok: true };
}

async function getAccessToken(apiBase) {
  if (process.env.EZVIZ_ACCESS_TOKEN) {
    return process.env.EZVIZ_ACCESS_TOKEN;
  }

  if (tokenCache.accessToken && Date.now() < tokenCache.expireAt - 60_000) {
    return tokenCache.accessToken;
  }

  const appKey = process.env.EZVIZ_APP_KEY;
  const appSecret = process.env.EZVIZ_APP_SECRET;

  if (!appKey || !appSecret) {
    return null;
  }

  const tokenPath = process.env.EZVIZ_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const tokenResult = await postForm(`${apiBase}${tokenPath}`, {
    appKey,
    appSecret,
  });

  const accessToken = tokenResult?.data?.accessToken;

  if (!accessToken) {
    return null;
  }

  const expireTime = Number(tokenResult?.data?.expireTime || tokenResult?.data?.expiresIn || 0);
  tokenCache.accessToken = accessToken;
  tokenCache.expireAt = expireTime > Date.now() ? expireTime : Date.now() + 6 * 60 * 60 * 1000;

  return tokenCache.accessToken;
}

async function getCameraFromDeviceList(apiBase, accessToken, table) {
  const deviceListPath = process.env.EZVIZ_DEVICE_LIST_PATH || DEFAULT_DEVICE_LIST_PATH;
  const listResult = await postForm(`${apiBase}${deviceListPath}`, {
    accessToken,
    pageStart: 0,
    pageSize: 50,
  });
  const devices = Array.isArray(listResult?.data) ? listResult.data : [];
  const tableNumber = String(Number(table));
  const paddedTableNumber = String(table).padStart(2, "0");
  const aliases = [
    `bàn ${tableNumber}`,
    `ban ${tableNumber}`,
    `bàn ${paddedTableNumber}`,
    `ban ${paddedTableNumber}`,
  ];
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedAliases = aliases.map(normalize);
  const matchesTable = (item) => {
    const name = normalize(item.deviceName || item.name);
    return normalizedAliases.some((alias) => name === alias);
  };
  const device =
    devices.find(matchesTable);

  if (!device?.deviceSerial) {
    return null;
  }

  return {
    deviceSerial: device.deviceSerial,
    channelNo: device.channelNo || device.cameraNo || 1,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }

  const table = String(req.query.table || "01").padStart(2, "0");
  const cameraMap = getCameraMap();
  let camera = cameraMap[table] || cameraMap[`Bàn ${table}`];

  const apiBase = process.env.EZVIZ_API_BASE;

  if (!apiBase) {
    return json(res, 200, {
      ok: false,
      setupRequired: true,
      message: "Chưa cấu hình EZVIZ_API_BASE trong Vercel Environment Variables.",
    });
  }

  try {
    const accessToken = await getAccessToken(apiBase);

    if (!accessToken) {
      return json(res, 200, {
        ok: false,
        setupRequired: true,
        message: "Chưa có EZVIZ_ACCESS_TOKEN hoặc EZVIZ_APP_KEY/EZVIZ_APP_SECRET.",
      });
    }

    if (!camera) {
      camera = await getCameraFromDeviceList(apiBase, accessToken, table);
    }

    if (!camera) {
      return json(res, 200, {
        ok: false,
        setupRequired: true,
        message: `Chưa tìm thấy camera cho bàn ${table}. Hãy cấu hình EZVIZ_CAMERA_MAP hoặc kiểm tra tài khoản EZVIZ có thiết bị chưa.`,
      });
    }

    const livePath = process.env.EZVIZ_LIVE_PATH || DEFAULT_LIVE_PATH;
    const preferredProtocol = camera.protocol || process.env.EZVIZ_PROTOCOL || 1;
    const preferredQuality = camera.quality || process.env.EZVIZ_QUALITY || 2;
    const liveResult = await postForm(`${apiBase}${livePath}`, {
      accessToken,
      deviceSerial: camera.deviceSerial,
      channelNo: camera.channelNo || 1,
      protocol: preferredProtocol,
      quality: preferredQuality,
    });

    const liveUrl =
      liveResult?.data?.url ||
      liveResult?.data?.liveAddress ||
      liveResult?.data?.hls ||
      liveResult?.data?.rtmp;
    const ezopenDomain = process.env.EZVIZ_EZOPEN_DOMAIN || DEFAULT_EZOPEN_DOMAIN;
    const validCode = camera.validCode || process.env.EZVIZ_VERIFY_CODE || null;
    const ezopenSuffix = preferredQuality === 1 ? "hd.live" : "live";
    const ezopenUrl = liveUrl?.startsWith("ezopen://")
      ? liveUrl.replace("ezopen://open.ezviz.com/", `ezopen://${ezopenDomain}/`)
      : `ezopen://${ezopenDomain}/${camera.deviceSerial}/${camera.channelNo || 1}.${ezopenSuffix}`;

    if (!liveUrl) {
      return json(res, 502, {
        ok: false,
        message: liveResult?.msg || "EZVIZ chưa trả về link xem camera.",
        ezviz: liveResult,
      });
    }

    const hlsCheck = await validateHlsUrl(liveUrl);

    if (!hlsCheck.ok) {
      return json(res, 200, {
        ok: false,
        table,
        message: `EZVIZ đã cấp link nhưng stream trả lỗi ${hlsCheck.code}. Camera chưa phát được HLS trên web.`,
        streamErrorCode: hlsCheck.code,
      });
    }

    return json(res, 200, {
      ok: true,
      table,
      liveUrl,
      ezopenUrl,
      accessToken,
      streamToken: liveResult?.data?.token,
      validCode,
      apiBase,
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      message: "Không gọi được EZVIZ API.",
      detail: error.message,
    });
  }
};
