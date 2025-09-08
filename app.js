

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const { customAlphabet } = require("nanoid");
const geoip = require("geoip-lite");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/urlshortener";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;


const LOG_ENDPOINT = process.env.LOG_ENDPOINT || "http://20.244.56.144/evaluation-service/logs";
const LOG_BEARER_TOKEN_RAW = process.env.LOG_BEARER_TOKEN || ""; 
const LOG_BEARER_TOKEN = LOG_BEARER_TOKEN_RAW.startsWith("Bearer ")
  ? LOG_BEARER_TOKEN_RAW.slice("Bearer ".length)
  : LOG_BEARER_TOKEN_RAW;


const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 6);

function nowIso() {
  return new Date().toISOString();
}

const ALLOWED_STACKS = new Set(["backend", "frontend"]);
const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);
const ALLOWED_PACKAGES = new Set([
  "cache","controller","cron_job","db","domain","handler","repository","route","service",
  "component","hook","page","state","style","auth","config","middleware","utils"
]);

async function postLogToServer(payload) {
  if (!LOG_BEARER_TOKEN) return { ok: false, reason: "no-token" };
  try {
    const res = await axios.post(LOG_ENDPOINT, payload, {
      headers: {
        Authorization: `Bearer ${LOG_BEARER_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 5000
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, reason: err.message, status: err.response?.status, data: err.response?.data };
  }
}

async function Log(stack, level, pkg, message, meta = {}) {
  try {
    if (!ALLOWED_STACKS.has(stack)) throw new Error("invalid stack");
    if (!ALLOWED_LEVELS.has(level)) throw new Error("invalid level");
    if (!ALLOWED_PACKAGES.has(pkg)) throw new Error("invalid package");
    if (!message || typeof message !== "string") throw new Error("message required");
  } catch (err) {
    console.error("[Log] validation:", err.message);
    return { ok: false, reason: err.message };
  }

  const payload = { stack, level, package: pkg, message, meta, timestamp: nowIso() };


  postLogToServer(payload).then(result => {
    if (!result.ok) {

      console.log("[LOG-BUFFERED]", JSON.stringify(payload));
    } else {
      
    }
  }).catch(err => {
    console.error("[Log] unexpected error:", err.message);
  });

  return { ok: true };
}

function requestLogger(req, res, next) {
  try {
    const meta = {
      method: req.method,
      url: req.originalUrl,
      ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"] || ""
    };

    Log("backend", "info", "middleware", `HTTP ${req.method} ${req.originalUrl}`, meta).catch(()=>{});
  } catch (err) {
    console.error("[requestLogger] error:", err.message);
  }
  next();
}

const clickSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  referrer: String,
  ip: String,
  userAgent: String,
  location: String
});

const urlSchema = new mongoose.Schema({
  originalUrl: { type: String, required: true },
  shortCode: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  expiryDate: { type: Date, required: true },
  clicks: [clickSchema]
});

const Url = mongoose.model("Url", urlSchema);
async function ensureUniqueShortCode(preferred) {
  if (preferred) {
    const exists = await Url.findOne({ shortCode: preferred });
    if (exists) return null; 
    return preferred;
  }
  let attempts = 0;
  while (attempts < 6) {
    const code = nanoid();
    const exists = await Url.findOne({ shortCode: code });
    if (!exists) return code;
    attempts++;
  }
  return null;
}

app.use(requestLogger);
app.post("/shorturls", async (req, res) => {
  try {
    const { url, validity = 30, shortcode } = req.body;
    if (!url || typeof url !== "string") {
      Log("backend", "warn", "handler", "createShortUrl: missing or invalid url", { body: req.body });
      return res.status(400).json({ error: "url is required" });
    }

    const codeToUse = await ensureUniqueShortCode(shortcode);
    if (!codeToUse) {
      Log("backend", "error", "handler", "createShortUrl: shortcode already taken or couldn't generate unique code", { shortcode });
      return res.status(400).json({ error: "shortcode already taken or couldn't generate unique shortcode" });
    }

    const expiryDate = new Date(Date.now() + parseInt(validity, 10) * 60000);
    const doc = await Url.create({ originalUrl: url, shortCode: codeToUse, expiryDate });

    Log("backend", "info", "controller", `Short URL created: ${codeToUse}`, { shortCode: codeToUse, expiry: expiryDate.toISOString() });

    return res.status(201).json({ shortLink: `${BASE_URL}/${codeToUse}`, expiry: expiryDate.toISOString() });
  } catch (err) {
    Log("backend", "fatal", "controller", "createShortUrl failed", { error: err.message });
    console.error("createShortUrl error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

app.get("/shorturls/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const doc = await Url.findOne({ shortCode: code });
    if (!doc) {
      return res.status(404).json({ error: "short url not found" });
    }

    return res.json({
      originalUrl: doc.originalUrl,
      createdAt: doc.createdAt,
      expiryDate: doc.expiryDate,
      totalClicks: doc.clicks.length,
      clicks: doc.clicks
    });
  } catch (err) {
    Log("backend", "fatal", "controller", "getStats failed", { error: err.message });
    console.error("getStats error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

app.get("/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const doc = await Url.findOne({ shortCode: code });
    if (!doc) {
      Log("backend", "warn", "handler", `redirect: shortcode ${code} not found`);
      return res.status(404).json({ error: "short url not found" });
    }

    if (doc.expiryDate < new Date()) {
      Log("backend", "info", "handler", `redirect: shortcode ${code} expired`);
      return res.status(410).json({ error: "short url expired" });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"] || "";
    const referrer = req.get("referer") || "direct";
    const geo = geoip.lookup(ip);
    const location = geo ? geo.country : "unknown";

    doc.clicks.push({ ip, userAgent, referrer, location });
    await doc.save();

    Log("backend", "info", "route", `redirect ${code} -> ${doc.originalUrl}`, { ip, location, referrer });

    return res.redirect(doc.originalUrl);
  } catch (err) {
    Log("backend", "fatal", "handler", "redirect failed", { error: err.message });
    console.error("redirect error:", err);
    return res.status(500).json({ error: "server error" });
  }
});


app.get("/health", (req, res) => res.json({ status: "ok" }));


(async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected");
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      Log("backend", "info", "service", `server started on ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
})();
