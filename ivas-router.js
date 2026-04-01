const express = require("express");
const https   = require("https");
const zlib    = require("zlib");

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL       = "https://www.ivasms.com";
const USER_AGENT     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

/* ================= COOKIES - Read from ENVIRONMENT VARIABLES ================= */
// Ye environment variables se le rahe hain (GitHub pe nahi jayega)
let COOKIES = {
  "XSRF-TOKEN":       process.env.XSRF_TOKEN || "",
  "ivas_sms_session": process.env.IVAS_SESSION || ""
};

/* ================= HELPERS ================= */
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function cookieString() {
  return Object.entries(COOKIES).map(([k,v]) => `${k}=${v}`).join("; ");
}

function getXsrf() {
  try { return decodeURIComponent(COOKIES["XSRF-TOKEN"] || ""); }
  catch { return COOKIES["XSRF-TOKEN"] || ""; }
}

function safeJSON(text) {
  try { return JSON.parse(text); }
  catch { return { error: "Invalid JSON", preview: text.substring(0, 300) }; }
}

/* ================= HTTP REQUEST ================= */
function makeRequest(method, path, body, contentType, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent":       USER_AGENT,
      "Accept":           "*/*",
      "Accept-Encoding":  "gzip, deflate, br",
      "Accept-Language":  "en-PK,en;q=0.9",
      "Cookie":           cookieString(),
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN":     getXsrf(),
      "X-CSRF-TOKEN":     getXsrf(),
      "Origin":           BASE_URL,
      "Referer":          `${BASE_URL}/portal`,
      ...extraHeaders
    };

    if (method === "POST" && body) {
      headers["Content-Type"]   = contentType;
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = https.request(BASE_URL + path, { method, headers }, res => {
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const sc = c.split(";")[0];
          const ki = sc.indexOf("=");
          if (ki > -1) {
            const k = sc.substring(0, ki).trim();
            const v = sc.substring(ki + 1).trim();
            if (k === "XSRF-TOKEN" || k === "ivas_sms_session") {
              COOKIES[k] = v;
            }
          }
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        try {
          const enc = res.headers["content-encoding"];
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch {}

        const text = buf.toString("utf-8");

        if (res.statusCode === 401 || res.statusCode === 419 ||
            text.includes('"message":"Unauthenticated"')) {
          return reject(new Error("SESSION_EXPIRED"));
        }

        resolve({ status: res.statusCode, body: text });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================= FETCH _token FROM PORTAL ================= */
async function fetchToken() {
  const resp = await makeRequest("GET", "/portal", null, null, {
    "Accept": "text/html,application/xhtml+xml,*/*"
  });
  const match = resp.body.match(/name="_token"\s+value="([^"]+)"/) ||
                resp.body.match(/"csrf-token"\s+content="([^"]+)"/);
  return match ? match[1] : null;
}

/* ================= PARSE HTML HELPERS ================= */
function stripHTML(html) {
  return (html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/* ================= GET NUMBERS ================= */
async function getNumbers(token) {
  const ts   = Date.now();
  const path = `/portal/numbers?draw=1`
    + `&columns[0][data]=number_id&columns[0][name]=id&columns[0][orderable]=false`
    + `&columns[1][data]=Number`
    + `&columns[2][data]=range`
    + `&columns[3][data]=A2P`
    + `&columns[4][data]=LimitA2P`
    + `&columns[5][data]=limit_cli_a2p`
    + `&columns[6][data]=limit_cli_did_a2p`
    + `&columns[7][data]=action&columns[7][searchable]=false&columns[7][orderable]=false`
    + `&order[0][column]=1&order[0][dir]=desc`
    + `&start=0&length=5000&search[value]=&_=${ts}`;

  const resp = await makeRequest("GET", path, null, null, {
    "Referer":      `${BASE_URL}/portal/numbers`,
    "Accept":       "application/json, text/javascript, */*; q=0.01",
    "X-CSRF-TOKEN": token
  });

  const json = safeJSON(resp.body);
  return fixNumbers(json);
}

function fixNumbers(json) {
  if (!json || !json.data) return json;
  const aaData = json.data.map(row => [
    row.range  || "",
    "",
    String(row.Number || ""),
    "Weekly",
    ""
  ]);
  return {
    sEcho: 2,
    iTotalRecords: String(json.recordsTotal || aaData.length),
    iTotalDisplayRecords: String(json.recordsFiltered || aaData.length),
    aaData
  };
}

/* ================= GET SMS ================= */
async function getSMS(token) {
  const today    = getToday();
  const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
    `--${boundary}--`
  ].join("\r\n");

  const r1 = await makeRequest(
    "POST", "/portal/sms/received/getsms", parts,
    `multipart/form-data; boundary=${boundary}`,
    {
      "Referer":    `${BASE_URL}/portal/sms/received`,
      "Accept":     "text/html, */*; q=0.01",
      "User-Agent": USER_AGENT
    }
  );

  const rangeMatches = [...r1.body.matchAll(/toggleRange\('([^']+)'/g)];
  const ranges = rangeMatches.map(m => m[1]);
  console.log(`[IVAS] Found ranges: ${ranges.join(", ")}`);

  if (ranges.length === 0) {
    return { sEcho: 1, iTotalRecords: "0", iTotalDisplayRecords: "0", aaData: [] };
  }

  const allRows = [];
  for (const range of ranges) {
    try {
      const body = new URLSearchParams({
        _token: token,
        start:  today,
        end:    today,
        range:  range
      }).toString();

      const r2 = await makeRequest(
        "POST", "/portal/sms/received/getsms/number", body,
        "application/x-www-form-urlencoded",
        {
          "Referer":    `${BASE_URL}/portal/sms/received`,
          "Accept":     "text/html, */*; q=0.01",
          "User-Agent": USER_AGENT
        }
      );

      const rows = parseNumberRows(r2.body, range, today);
      allRows.push(...rows);
    } catch(e) {
      console.warn(`[IVAS] Range ${range} failed:`, e.message);
    }
  }

  return {
    sEcho: 1,
    iTotalRecords: String(allRows.length),
    iTotalDisplayRecords: String(allRows.length),
    aaData: allRows
  };
}

function parseNumberRows(html, range, date) {
  const rows = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row  = rowMatch[1];
    const tds  = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
      m[1].replace(/<[^>]+>/g, "").trim()
    );
    
    if (tds.length >= 2) {
      const number  = tds.find(t => /^\d{7,15}$/.test(t.replace(/\s/,""))) || "";
      const message = tds.find(t => t.length > 5 && !/^\d+$/.test(t) && t !== number) || "";
      
      if (number || message) {
        rows.push([
          new Date().toISOString().replace("T"," ").substring(0,19),
          range,
          number,
          "SMS",
          message,
          "$",
          0
        ]);
      }
    }
  }
  
  return rows;
}

/* ================= ROUTES ================= */

router.get("/", async (req, res) => {
  const { type } = req.query;
  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    const token = await fetchToken();
    if (!token) {
      return res.status(401).json({
        error: "Session expired",
        fix:   "POST /api/ivasms/update-session with xsrf and session cookies"
      });
    }

    if (type === "numbers") return res.json(await getNumbers(token));
    if (type === "sms")     return res.json(await getSMS(token));

    res.json({ error: "Invalid type. Use numbers or sms" });

  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      return res.status(401).json({
        error: "Session expired — update cookies",
        fix:   "POST /api/ivasms/update-session with xsrf and session"
      });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get("/raw-sms", async (req, res) => {
  try {
    const token    = await fetchToken();
    const today    = getToday();
    const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
      `--${boundary}--`
    ].join("\r\n");
    
    const r1 = await makeRequest("POST", "/portal/sms/received/getsms", parts,
      `multipart/form-data; boundary=${boundary}`,
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": USER_AGENT }
    );
    
    const rangeMatch = r1.body.match(/toggleRange\('([^']+)'/);
    if (!rangeMatch) return res.send("No ranges:\n" + r1.body.substring(0,1000));
    const range = rangeMatch[1];
    
    const r2 = await makeRequest("POST", "/portal/sms/received/getsms/number",
      new URLSearchParams({ _token: token, start: today, end: today, range }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": USER_AGENT }
    );
    
    const numMatch = r2.body.match(/toggleNum[^(]+\('(\d+)'/);
    if (!numMatch) return res.send(`Range: ${range}\nNo numbers:\n` + r2.body.substring(0,1000));
    const number = numMatch[1];
    
    const r3 = await makeRequest("POST", "/portal/sms/received/getsms/number/sms",
      new URLSearchParams({ _token: token, start: today, end: today, Number: number, Range: range }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": USER_AGENT }
    );
    
    res.set("Content-Type", "text/plain");
    res.send(`Range: ${range}\nNumber: ${number}\n\n` + r3.body.substring(0, 5000));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post("/update-session", express.json(), (req, res) => {
  const { xsrf, session } = req.body || {};
  if (!xsrf || !session) {
    return res.status(400).json({
      error: "Required: xsrf and session",
      example: { xsrf: "XSRF-TOKEN value", session: "ivas_sms_session value" }
    });
  }
  COOKIES["XSRF-TOKEN"]       = xsrf;
  COOKIES["ivas_sms_session"] = session;
  console.log("✅ [IVAS] Cookies updated manually");
  res.json({ success: true, message: "Cookies updated!" });
});

router.get("/status", async (req, res) => {
  try {
    const token = await fetchToken();
    res.json({
      status:    token ? "✅ Session active" : "❌ Session expired",
      hasToken:  !!token,
      cookieKeys: Object.keys(COOKIES)
    });
  } catch (e) {
    res.json({ status: "❌ Session expired", error: e.message });
  }
});

module.exports = router;
