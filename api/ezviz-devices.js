const DEFAULT_DEVICE_LIST_PATH = "/api/lapp/device/list";
const DEFAULT_TOKEN_PATH = "/api/lapp/token/get";
const tokenCache = {
  accessToken: null,
  expireAt: 0,
};

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
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
  if (tokenCache.accessToken && Date.now() < tokenCache.expireAt - 60_000) {
    return tokenCache.accessToken;
  }

  const appKey = process.env.EZVIZ_APP_KEY;
  const appSecret = process.env.EZVIZ_APP_SECRET;

  if (!appKey || !appSecret) {
    return process.env.EZVIZ_ACCESS_TOKEN || null;
  }

  const result = await postForm(`${apiBase}${process.env.EZVIZ_TOKEN_PATH || DEFAULT_TOKEN_PATH}`, {
    appKey,
    appSecret,
  });
  const accessToken = result?.data?.accessToken;

  if (!accessToken) {
    return process.env.EZVIZ_ACCESS_TOKEN || null;
  }

  const expireTime = Number(result?.data?.expireTime || result?.data?.expiresIn || 0);
  tokenCache.accessToken = accessToken;
  tokenCache.expireAt = expireTime > Date.now() ? expireTime : Date.now() + 6 * 60 * 60 * 1000;

  return tokenCache.accessToken;
}

module.exports = async function handler(req, res) {
  const apiBase = process.env.EZVIZ_API_BASE;

  if (!apiBase) {
    return json(res, 200, {
      ok: false,
      message: "Missing EZVIZ_API_BASE.",
    });
  }

  const accessToken = await getAccessToken(apiBase);

  if (!accessToken) {
    return json(res, 200, {
      ok: false,
      message: "Missing EZVIZ_ACCESS_TOKEN or EZVIZ_APP_KEY/EZVIZ_APP_SECRET.",
    });
  }

  const deviceListPath = process.env.EZVIZ_DEVICE_LIST_PATH || DEFAULT_DEVICE_LIST_PATH;
  const result = await postForm(`${apiBase}${deviceListPath}`, {
    accessToken,
    pageStart: 0,
    pageSize: 50,
  });

  const devices = Array.isArray(result?.data) ? result.data : [];

  return json(res, 200, {
    ok: true,
    count: devices.length,
    devices: devices.map((device) => ({
      deviceSerial: device.deviceSerial,
      deviceName: device.deviceName,
      name: device.name,
      channelNo: device.channelNo,
      cameraNo: device.cameraNo,
      status: device.status,
    })),
    rawCode: result?.code,
    rawMessage: result?.msg,
  });
};
