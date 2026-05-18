const ezvizLive = require("./ezviz-live");

module.exports = async function handler(req, res) {
  const callback = String(req.query.callback || "callback").replace(/[^\w$.]/g, "");
  let body = "";
  let statusCode = 200;

  const jsonRes = {
    setHeader() {},
    end(value) {
      body += value || "";
    },
    set statusCode(value) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
  };

  await ezvizLive(req, jsonRes);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.end(`${callback}(${body});`);
};
