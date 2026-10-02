const BUSINESS_TIMEZONE_OFFSET_MINUTES = 7 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseInvoiceDay(value) {
  const text = String(value || "").trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/);

  if (match) {
    [, year, month, day] = match;
  } else {
    match = text.match(/^(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*|\s+)(\d{4})/);
    if (!match) return null;
    [, day, month, year] = match;
  }

  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day)
  ) return null;
  return timestamp;
}

function getInvoiceAgeDays(value, now = new Date()) {
  const invoiceDay = parseInvoiceDay(value);
  if (invoiceDay === null) return null;

  const businessNow = new Date(now.getTime() + BUSINESS_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const today = Date.UTC(businessNow.getUTCFullYear(), businessNow.getUTCMonth(), businessNow.getUTCDate());
  return Math.floor((today - invoiceDay) / DAY_MS);
}

module.exports = { getInvoiceAgeDays };
