const DEFAULT_TOKEN_PATH = "/api/lapp/token/get";
const DEFAULT_DEVICE_LIST_PATH = "/api/lapp/device/list";
const DEFAULT_EZOPEN_DOMAIN = "open.ezviz.com";
const DEFAULT_CAMERA_MAP = {
  "01": { deviceSerial: "BF3334699", channelNo: 1 },
  "02": { deviceSerial: "BF3334697", channelNo: 1 },
  "03": { deviceSerial: "BF3334132", channelNo: 1 },
  "04": { deviceSerial: "BF3332757", channelNo: 1 },
  "05": { deviceSerial: "BF3333519", channelNo: 1 },
  "06": { deviceSerial: "BF3334412", channelNo: 1 },
  "07": { deviceSerial: "BF3332973", channelNo: 1 },
  "08": { deviceSerial: "BF3333099", channelNo: 1 },
  "09": { deviceSerial: "BF3333579", channelNo: 1 },
  "10": { deviceSerial: "BF3334658", channelNo: 1 },
  "11": { deviceSerial: "BF9642082", channelNo: 1 },
  "12": { deviceSerial: "BF9642529", channelNo: 1 },
  "13": { deviceSerial: "BF9642220", channelNo: 1 },
  "14": { deviceSerial: "BF9642392", channelNo: 1, validCode: "WRYZOM" },
};
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
    return DEFAULT_CAMERA_MAP;
  }

  try {
    return { ...DEFAULT_CAMERA_MAP, ...JSON.parse(process.env.EZVIZ_CAMERA_MAP) };
  } catch (error) {
    return DEFAULT_CAMERA_MAP;
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

  const result = await postForm(`${apiBase}${process.env.EZVIZ_TOKEN_PATH || DEFAULT_TOKEN_PATH}`, {
    appKey,
    appSecret,
  });
  const accessToken = result?.data?.accessToken;

  if (!accessToken) {
    return null;
  }

  const expireTime = Number(result?.data?.expireTime || result?.data?.expiresIn || 0);
  tokenCache.accessToken = accessToken;
  tokenCache.expireAt = expireTime > Date.now() ? expireTime : Date.now() + 6 * 60 * 60 * 1000;

  return tokenCache.accessToken;
}

async function getCameraFromDeviceList(apiBase, accessToken, table) {
  const result = await postForm(`${apiBase}${process.env.EZVIZ_DEVICE_LIST_PATH || DEFAULT_DEVICE_LIST_PATH}`, {
    accessToken,
    pageStart: 0,
    pageSize: 50,
  });
  const devices = Array.isArray(result?.data) ? result.data : [];
  const tableNumber = String(Number(table));
  const padded = String(table).padStart(2, "0");
  const aliases = [`ban ${tableNumber}`, `ban ${padded}`];
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedAliases = aliases.map(normalize);
  const device = devices.find((item) => normalizedAliases.some((alias) => normalize(item.deviceName || item.name) === alias));

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

  const apiBase = process.env.EZVIZ_API_BASE;
  const table = String(req.query.table || "01").padStart(2, "0");
  const cameraMap = getCameraMap();
  let camera = cameraMap[table] || cameraMap[`Ban ${table}`];

  if (!apiBase) {
    return json(res, 200, {
      ok: false,
      setupRequired: true,
      message: "Missing EZVIZ_API_BASE.",
    });
  }

  try {
    const accessToken = await getAccessToken(apiBase);

    if (!accessToken) {
      return json(res, 200, {
        ok: false,
        setupRequired: true,
        message: "Missing EZVIZ_ACCESS_TOKEN or EZVIZ_APP_KEY/EZVIZ_APP_SECRET.",
      });
    }

    if (!camera) {
      camera = await getCameraFromDeviceList(apiBase, accessToken, table);
    }

    if (!camera) {
      return json(res, 200, {
        ok: false,
        setupRequired: true,
        message: `Khong tim thay camera cho Ban ${table}.`,
      });
    }

    const ezopenDomain = process.env.EZVIZ_EZOPEN_DOMAIN || DEFAULT_EZOPEN_DOMAIN;
    const quality = process.env.EZVIZ_QUALITY || camera.quality || 2;
    const suffix = Number(quality) === 1 ? "hd.live" : "live";
    const ezopenUrl = `ezopen://${ezopenDomain}/${camera.deviceSerial}/${camera.channelNo || 1}.${suffix}`;

    return json(res, 200, {
      ok: true,
      table,
      liveUrl: ezopenUrl,
      ezopenUrl,
      accessToken,
      streamToken: null,
      validCode: camera.validCode || process.env.EZVIZ_VERIFY_CODE || null,
      apiBase,
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      message: "Khong goi duoc EZVIZ API.",
      detail: error.message,
    });
  }
};
