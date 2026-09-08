const BUCKET = "ad-banners";
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function verifyAdminSession(baseUrl, serviceKey, authorization) {
  if (!/^Bearer\s+\S+/i.test(authorization || "")) return false;
  const response = await fetch(`${baseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authorization },
  });
  return response.ok;
}

async function ensurePublicBucket(baseUrl, serviceKey) {
  const check = await fetch(`${baseUrl}/storage/v1/bucket/${BUCKET}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (check.ok) return;
  if (check.status !== 404 && check.status !== 400) throw new Error(`Không kiểm tra được kho banner (HTTP ${check.status}).`);
  const create = await fetch(`${baseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: MAX_BYTES }),
  });
  if (!create.ok && create.status !== 409) throw new Error(`Không tạo được kho banner (HTTP ${create.status}).`);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return json(res, 500, { ok: false, message: "Chưa cấu hình Supabase Storage." });
  try {
    if (!(await verifyAdminSession(baseUrl, serviceKey, req.headers.authorization))) {
      return json(res, 401, { ok: false, message: "Phiên đăng nhập admin không hợp lệ." });
    }
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const type = String(body.type || "").toLowerCase();
    const originalName = String(body.name || "").trim();
    const safeName = originalName.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
    if (!safeName || !ALLOWED_TYPES.has(type)) return json(res, 400, { ok: false, message: "Tên hoặc định dạng hình không hợp lệ." });
    const bytes = Buffer.from(String(body.data || ""), "base64");
    if (!bytes.length || bytes.length > MAX_BYTES) return json(res, 400, { ok: false, message: "Hình phải có dung lượng từ 1 byte đến 4 MB." });
    await ensurePublicBucket(baseUrl, serviceKey);
    const objectPath = encodeURIComponent(safeName);
    const upload = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": type,
        "x-upsert": "true",
      },
      body: bytes,
    });
    const uploadText = await upload.text();
    if (!upload.ok) throw new Error(`Không tải được hình lên Storage: ${uploadText || `HTTP ${upload.status}`}`);
    const url = `${baseUrl}/storage/v1/object/public/${BUCKET}/${objectPath}`;
    return json(res, 200, { ok: true, name: safeName, url });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || "Không tải được banner." });
  }
};
