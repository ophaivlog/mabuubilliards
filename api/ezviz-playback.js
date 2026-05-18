const DEFAULT_DEVICE_LIST_PATH = "/api/lapp/device/list";
const DEFAULT_TOKEN_PATH = "/api/lapp/token/get";
const DEFAULT_EZOPEN_DOMAIN = "open.ezviz.com";
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

async function findCameraByName(apiBase, accessToken, table) {
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
  const device = devices.find((item) => aliases.some((alias) => normalize(item.deviceName || item.name).includes(alias)));

  if (!device?.deviceSerial) {
    return null;
  }

  return {
    deviceSerial: device.deviceSerial,
    channelNo: device.channelNo || device.cameraNo || 1,
  };
}

function toEzvizTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const pad = (number) => String(number).padStart(2, "0");

  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }

  const apiBase = process.env.EZVIZ_API_BASE;
  const table = String(req.query.table || "01").padStart(2, "0");
  const begin = toEzvizTime(req.query.begin);
  const end = toEzvizTime(req.query.end);

  if (!apiBase) {
    return json(res, 200, { ok: false, message: "Thieu EZVIZ_API_BASE." });
  }

  const accessToken = await getAccessToken(apiBase);

  if (!accessToken) {
    return json(res, 200, { ok: false, message: "Thieu EZVIZ_ACCESS_TOKEN hoac EZVIZ_APP_KEY/EZVIZ_APP_SECRET." });
  }

  if (!begin || !end) {
    return json(res, 200, { ok: false, message: "Vui long chon thoi gian bat dau va ket thuc." });
  }

  const cameraMap = getCameraMap();
  let camera = cameraMap[table] || cameraMap[`Ban ${table}`];

  if (!camera) {
    camera = await findCameraByName(apiBase, accessToken, table);
  }

  if (!camera) {
    return json(res, 200, { ok: false, message: `Khong tim thay camera cho Ban ${table}.` });
  }

  const ezopenDomain = process.env.EZVIZ_EZOPEN_DOMAIN || DEFAULT_EZOPEN_DOMAIN;
  const quality = camera.quality || process.env.EZVIZ_QUALITY || 1;
  const definition = Number(quality) === 1 ? "hd." : "";
  const rawRecType = process.env.EZVIZ_REC_TYPE || "rec";
  const recType = rawRecType === "rec" || rawRecType.endsWith(".rec") ? rawRecType : `${rawRecType}.rec`;
  const ezopenUrl = `ezopen://${ezopenDomain}/${camera.deviceSerial}/${camera.channelNo || 1}.${definition}${recType}?begin=${begin}&end=${end}`;

  return json(res, 200, {
    ok: true,
    table,
    ezopenUrl,
    accessToken,
    validCode: camera.validCode || process.env.EZVIZ_VERIFY_CODE || null,
    apiBase,
    begin,
    end,
  });
};
