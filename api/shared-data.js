const DEFAULT_PRIZES = ["Giảm 10%", "Nước miễn phí", "Tặng 1 giờ bàn", "Chúc may mắn", "Giảm 20%", "Áo Ma Buu", "Voucher 50K", "Quay lại"];
const { getInvoiceAgeDays } = require("./invoice-date");

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function config() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error("Chưa cấu hình kết nối Supabase trên máy chủ."), { statusCode: 500 });
  return { url, key };
}

async function request(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(body?.message || text || `Supabase HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return body;
}

async function requireAdmin(authorization) {
  if (!/^Bearer\s+\S+/i.test(authorization || "")) return false;
  const { url, key } = config();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: authorization },
  });
  return response.ok;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function amount(value) {
  const digits = String(value ?? "").replace(/[^0-9-]/g, "");
  if (!digits || digits === "-") return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateInvoice(invoice) {
  const number = String(invoice?.invoice_number || "").trim();
  if (normalizeText(invoice?.store_name) !== "mabuubilliardsclub") throw Object.assign(new Error("Sai đơn vị quán trên biên lai."), { statusCode: 400 });
  if (!String(invoice?.date || "").trim() || !/^HD\d{6}$/i.test(number)) throw Object.assign(new Error("Thông tin ngày hoặc mã phiếu không hợp lệ."), { statusCode: 400 });
  const invoiceAgeDays = getInvoiceAgeDays(invoice.date);
  if (invoiceAgeDays === null) throw Object.assign(new Error("Không đọc được ngày trên hóa đơn."), { statusCode: 400 });
  if (invoiceAgeDays < 0) throw Object.assign(new Error("Ngày hóa đơn không được nằm trong tương lai."), { statusCode: 400 });
  if (invoiceAgeDays > 2) throw Object.assign(new Error("Hóa đơn đã quá hạn. Chỉ chấp nhận hóa đơn trong vòng 2 ngày gần nhất."), { statusCode: 400 });
  const item = (Array.isArray(invoice?.items) ? invoice.items : []).find((row) => normalizeText(row?.name) === "bidapool");
  const eligibleAmount = amount(item?.total_price);
  const points = eligibleAmount === null ? null : Math.round(eligibleAmount / 1000);
  const unitPrice = amount(item?.unit_price);
  const total = amount(invoice.total_amount);
  if (!item || !String(item.quantity ?? "").trim() || unitPrice === null || unitPrice <= 0 || !points || points <= 0 || total === null || total <= 0) {
    throw Object.assign(new Error("Biên lai thiếu thông tin hợp lệ của mục BIDA POOL."), { statusCode: 400 });
  }
  return { number, points };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const type = String(req.query?.type || "");
      if (type === "mini-game") {
        const settings = await request("mini_game_settings?id=eq.main&select=prizes");
        const history = await request("mini_game_history?select=id,prize,spun_at&order=spun_at.desc&limit=8");
        return json(res, 200, { ok: true, prizes: settings?.[0]?.prizes || DEFAULT_PRIZES, history: history || [] });
      }
      if (type === "loyalty") {
        const phone = normalizePhone(req.query?.phone);
        if (phone.length < 9 || phone.length > 11) return json(res, 400, { ok: false, message: "Số điện thoại không hợp lệ." });
        const members = await request(`loyalty_members?phone=eq.${encodeURIComponent(phone)}&select=phone,name,points,created_at`);
        const receipts = await request(`loyalty_receipts?member_phone=eq.${encodeURIComponent(phone)}&select=invoice_number,member_phone,member_name,points,used_at&order=used_at.desc`);
        let rewardClaims = [];
        try {
          rewardClaims = await request(`loyalty_reward_claims?member_phone=eq.${encodeURIComponent(phone)}&select=reward_code,claimed_at,handed_at&order=claimed_at.desc`);
        } catch (error) {
          if (![400, 404].includes(error.statusCode)) throw error;
        }
        let pointAdjustments = [];
        try {
          pointAdjustments = await request(`loyalty_point_adjustments?member_phone=eq.${encodeURIComponent(phone)}&select=member_phone,points,reason,adjusted_at&order=adjusted_at.desc`);
        } catch (error) {
          if (error.statusCode !== 404) throw error;
        }
        return json(res, 200, { ok: true, member: members?.[0] || null, receipts: receipts || [], rewardClaims: rewardClaims || [], pointAdjustments: pointAdjustments || [] });
      }
      if (type === "admin-loyalty") {
        if (!(await requireAdmin(req.headers.authorization))) return json(res, 401, { ok: false, message: "Cần đăng nhập admin để xem dữ liệu thành viên." });
        const members = await request("loyalty_members?select=phone,name,points,created_at&order=created_at.desc");
        const receipts = await request("loyalty_receipts?select=invoice_number,member_phone,member_name,points,used_at&order=used_at.desc&limit=10000");
        let rewardClaims = [];
        try {
          rewardClaims = await request("loyalty_reward_claims?select=member_phone,reward_code,claimed_at,handed_at&order=claimed_at.desc");
        } catch (error) {
          if (![400, 404].includes(error.statusCode)) throw error;
        }
        let pointAdjustments = [];
        try {
          pointAdjustments = await request("loyalty_point_adjustments?select=member_phone,points,reason,adjusted_at&order=adjusted_at.desc");
        } catch (error) {
          if (error.statusCode !== 404) throw error;
        }
        return json(res, 200, { ok: true, members: members || [], receipts: receipts || [], rewardClaims: rewardClaims || [], pointAdjustments: pointAdjustments || [] });
      }
      return json(res, 400, { ok: false, message: "Loại dữ liệu không hợp lệ." });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { ok: false, message: "Method not allowed" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body.action === "register-member") {
      const phone = normalizePhone(body.phone);
      const name = String(body.name || "").trim().slice(0, 120);
      if (phone.length < 9 || phone.length > 11 || !name) return json(res, 400, { ok: false, message: "Tên hoặc số điện thoại không hợp lệ." });
      const rows = await request("loyalty_members", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ phone, name, points: 0 }),
      });
      return json(res, 201, { ok: true, member: rows?.[0] });
    }

    if (body.action === "redeem-receipt") {
      const phone = normalizePhone(body.phone);
      const { number, points } = validateInvoice(body.invoice);
      const rows = await request("rpc/apply_loyalty_receipt", {
        method: "POST",
        body: JSON.stringify({ p_invoice_number: number, p_member_phone: phone, p_points: points }),
      });
      return json(res, 200, { ok: true, ...rows });
    }

    if (body.action === "claim-loyalty-reward") {
      const phone = normalizePhone(body.phone);
      const rewardCode = String(body.rewardCode || "");
      if (phone.length < 9 || phone.length > 11) return json(res, 400, { ok: false, message: "Số điện thoại không hợp lệ." });
      const rows = await request("rpc/claim_loyalty_reward", {
        method: "POST",
        body: JSON.stringify({ p_member_phone: phone, p_reward_code: rewardCode }),
      });
      return json(res, 200, { ok: true, claim: rows });
    }

    if (body.action === "set-member-points") {
      if (!(await requireAdmin(req.headers.authorization))) return json(res, 401, { ok: false, message: "Cần đăng nhập admin để sửa điểm." });
      const phone = normalizePhone(body.phone);
      const targetPoints = Number(body.targetPoints);
      if (phone.length < 9 || phone.length > 11 || !Number.isSafeInteger(targetPoints) || targetPoints < 0 || targetPoints > 1000000000) {
        return json(res, 400, { ok: false, message: "Số điện thoại hoặc tổng điểm mới không hợp lệ." });
      }
      const result = await request("rpc/admin_set_loyalty_points", {
        method: "POST",
        body: JSON.stringify({ p_member_phone: phone, p_target_points: targetPoints }),
      });
      return json(res, 200, { ok: true, ...result });
    }

    if (body.action === "admin-confirm-loyalty-reward") {
      if (!(await requireAdmin(req.headers.authorization))) return json(res, 401, { ok: false, message: "Cần đăng nhập admin để xác nhận trao quà." });
      const phone = normalizePhone(body.phone);
      const rewardCode = String(body.rewardCode || "");
      if (phone.length < 9 || phone.length > 11) return json(res, 400, { ok: false, message: "Số điện thoại không hợp lệ." });
      const claim = await request("rpc/admin_confirm_loyalty_reward", {
        method: "POST",
        body: JSON.stringify({ p_member_phone: phone, p_reward_code: rewardCode }),
      });
      return json(res, 200, { ok: true, claim });
    }

    if (body.action === "record-spin") {
      const prize = String(body.prize || "").trim().slice(0, 120);
      if (!prize) return json(res, 400, { ok: false, message: "Phần thưởng không hợp lệ." });
      await request("mini_game_history", { method: "POST", body: JSON.stringify({ prize }) });
      const history = await request("mini_game_history?select=id,prize,spun_at&order=spun_at.desc&limit=8");
      return json(res, 201, { ok: true, history: history || [] });
    }

    if (body.action === "save-mini-game") {
      if (!(await requireAdmin(req.headers.authorization))) return json(res, 401, { ok: false, message: "Cần đăng nhập admin để sửa giải thưởng." });
      const prizes = Array.isArray(body.prizes) ? body.prizes.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 24) : [];
      if (prizes.length < 2) return json(res, 400, { ok: false, message: "Cần ít nhất 2 phần thưởng." });
      await request("mini_game_settings?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id: "main", prizes, updated_at: new Date().toISOString() }),
      });
      if (body.resetHistory) await request("mini_game_history?id=not.is.null", { method: "DELETE" });
      return json(res, 200, { ok: true, prizes });
    }

    if (body.action === "reset-member-points") {
      if (!(await requireAdmin(req.headers.authorization))) return json(res, 401, { ok: false, message: "Cần đăng nhập admin để xóa điểm." });
      const phone = normalizePhone(body.phone);
      if (phone.length < 9 || phone.length > 11) return json(res, 400, { ok: false, message: "Số điện thoại không hợp lệ." });
      const members = await request(`loyalty_members?phone=eq.${encodeURIComponent(phone)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ points: 0 }),
      });
      if (!members?.length) return json(res, 404, { ok: false, message: "Không tìm thấy thành viên." });
      return json(res, 200, { ok: true, member: members[0] });
    }

    return json(res, 400, { ok: false, message: "Thao tác không hợp lệ." });
  } catch (error) {
    const status = error.code === "23505" ? 409 : error.statusCode || 500;
    const rawMessage = error.message || "";
    const message = rawMessage.includes("MILESTONE_NOT_REACHED")
      ? "Bạn chưa đạt đủ điểm trong 12 tháng để nhận mốc quà này."
      : rawMessage.includes("INVALID_TARGET_POINTS")
        ? "Tổng điểm mới phải từ 0 đến 1.000.000.000."
      : rawMessage.includes("REWARD_ALREADY_CLAIMED")
        ? "Mốc quà này đã được nhận trước đó."
        : rawMessage.includes("INVALID_REWARD")
          ? "Mốc quà không hợp lệ."
          : rawMessage.includes("MEMBER_NOT_FOUND")
            ? "Không tìm thấy hội viên."
            : rawMessage.includes("INVALID_TARGET_POINTS")
              ? "Tổng điểm mới không hợp lệ."
            : error.code === "23505"
      ? "Số điện thoại đã đăng ký hoặc phiếu này đã được sử dụng."
      : rawMessage || "Không xử lý được dữ liệu Supabase.";
    return json(res, status, { ok: false, message });
  }
};
