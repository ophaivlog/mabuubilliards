const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(res, 503, { ok: false, message: "Chưa cấu hình GEMINI_API_KEY trên máy chủ." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const mimeType = String(body.mimeType || "").toLowerCase();
    const imageData = String(body.imageData || "").replace(/^data:[^,]+,/, "");
    if (!ALLOWED_TYPES.has(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageData)) {
      return json(res, 400, { ok: false, message: "Ảnh phải có định dạng JPG, PNG hoặc WEBP." });
    }

    const imageBytes = Buffer.from(imageData, "base64");
    if (!imageBytes.length || imageBytes.length > MAX_IMAGE_BYTES) {
      return json(res, 400, { ok: false, message: "Ảnh biên lai vượt quá giới hạn 6 MB." });
    }

    const imageBase64 = imageBytes.toString("base64");
    const prompt = "Đọc ảnh hóa đơn hoặc biên lai chuyển khoản. Trích xuất thông tin nhìn thấy được thành JSON chuẩn với các trường store_name, date, invoice_number, items (mỗi mục gồm name, quantity, unit_price, total_price), total_amount. Trường date phải là ngày/tháng/năm được in trên hóa đơn, không dùng ngày chụp hoặc ngày tải ảnh; chuẩn hóa thành YYYY-MM-DD kể cả khi ngày in có khoảng trắng giữa các phần (ví dụ 21 / 09 2026 thành 2026-09-21). Với biên lai chuyển khoản, dùng tên ngân hàng hoặc người nhận cho store_name, mã giao dịch cho invoice_number, và số tiền giao dịch cho total_amount. Không đoán thông tin không nhìn rõ; dùng chuỗi rỗng hoặc mảng rỗng khi không có dữ liệu.";
    const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
    let response;
    let result;
    for (const model of models) {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: imageBase64 } },
              ],
            }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        },
      );

      result = await response.json();
      if (response.ok) break;

      const upstreamStatus = String(result?.error?.status || "").toUpperCase();
      const isTemporaryCapacityError = [429, 500, 503].includes(response.status)
        || ["RESOURCE_EXHAUSTED", "UNAVAILABLE"].includes(upstreamStatus)
        || /high demand|temporarily unavailable/i.test(result?.error?.message || "");
      const isLastModel = model === models.at(-1);
      if (!isTemporaryCapacityError || isLastModel) {
        const message = isTemporaryCapacityError
          ? "AI đang quá tải, vui lòng thử lại sau ít phút."
          : result?.error?.message || `Gemini trả về HTTP ${response.status}.`;
        return json(res, 502, { ok: false, message });
      }
    }

    const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text) return json(res, 502, { ok: false, message: "AI không đọc được nội dung trong ảnh." });
    const invoice = JSON.parse(text);
    return json(res, 200, { ok: true, invoice });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || "Không quét được biên lai." });
  }
};
