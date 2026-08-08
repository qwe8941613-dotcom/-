const express = require("express");
const fs = require("fs");
const path = require("path");
const PFMLogic = require("./pfm-logic.js");

const app = express();
const PORT = process.env.PORT || 5050;
// On a host with an ephemeral filesystem (most cloud platforms redeploy into
// a fresh container), point DATA_DIR at a mounted persistent volume so data
// survives redeploys/restarts. Defaults to this folder for local/LAN use.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "data.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_REVIEW_MAX_LENGTH = 2000;
const AI_REVIEW_RATE_LIMIT = 20; // 每 IP 每小時，跟 ai-chat-web 用同一套邏輯
const AI_REVIEW_RATE_WINDOW_MS = 60 * 60 * 1000;

// 部署在 Render 這類平台時，真正的訪客 IP 在 X-Forwarded-For 裡。
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const aiReviewBuckets = new Map();
function checkAiReviewRateLimit(ip) {
  const now = Date.now();
  const entry = aiReviewBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    aiReviewBuckets.set(ip, { count: 1, resetAt: now + AI_REVIEW_RATE_WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= AI_REVIEW_RATE_LIMIT) {
    return { ok: false, retryAfterMinutes: Math.max(1, Math.ceil((entry.resetAt - now) / 60000)) };
  }
  entry.count += 1;
  return { ok: true };
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  const p1 = uid("p");
  const wo1 = uid("wo");
  const st1 = uid("st"), st2 = uid("st"), st3 = uid("st"), st4 = uid("st");
  return {
    products: [{ id: p1, name: "80CS", spec: "" }],
    workOrders: [{ id: wo1, no: "WO-20260808-01", productId: p1, plannedQty: 100, status: "in_progress", createdAt: Date.now(), createdBy: "系統預設" }],
    stations: [
      { id: st1, name: "接 Block" },
      { id: st2, name: "清洗站" },
      { id: st3, name: "檢驗站" },
      { id: st4, name: "包裝站" },
    ],
    exceptionTypes: [
      { id: uid("ex"), type: "Block 不良", targetStationName: "清洗站" },
      { id: uid("ex"), type: "尺寸不符", targetStationName: "檢驗站" },
    ],
    records: [],
  };
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.products && parsed.stations) return parsed;
    }
  } catch (e) {
    console.error("讀取 data.json 失敗，改用預設資料：", e.message);
  }
  const seed = defaultState();
  saveState(seed);
  return seed;
}

function saveState(state) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, DATA_FILE);
}

let state = loadState();

/* ---- helpers mirroring the client-side validation in the original app ---- */
function findProduct(id) { return state.products.find(p => p.id === id); }
function findWO(id) { return state.workOrders.find(w => w.id === id); }
function findStation(name) { return state.stations.find(s => s.name === name); }
function findExType(name) { return state.exceptionTypes.find(e => e.type === name); }

app.get("/api/state", (req, res) => {
  res.json(state);
});

app.post("/api/products", (req, res) => {
  const name = (req.body.name || "").trim();
  const spec = (req.body.spec || "").trim();
  if (!name) return res.status(400).json({ error: "請輸入產品名稱" });
  if (state.products.some(p => p.name === name)) return res.status(400).json({ error: "此產品名稱已存在" });
  const product = { id: uid("p"), name, spec };
  state.products.push(product);
  saveState(state);
  res.json(product);
});

app.post("/api/workorders", (req, res) => {
  const { productId } = req.body;
  const no = (req.body.no || "").trim();
  const plannedQty = parseInt(req.body.plannedQty, 10);
  if (!productId || !findProduct(productId)) return res.status(400).json({ error: "請選擇有效產品" });
  if (!no) return res.status(400).json({ error: "請輸入工單號碼" });
  if (state.workOrders.some(w => w.no === no)) return res.status(400).json({ error: "此工單號碼已存在" });
  if (!plannedQty || plannedQty <= 0) return res.status(400).json({ error: "預計生產數量須為正整數" });
  const wo = { id: uid("wo"), no, productId, plannedQty, status: "in_progress", createdAt: Date.now(), createdBy: req.body.createdBy || "操作人員" };
  state.workOrders.push(wo);
  saveState(state);
  res.json(wo);
});

app.post("/api/stations", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "請輸入站別名稱" });
  if (findStation(name)) return res.status(400).json({ error: "此站別名稱已存在" });
  const station = { id: uid("st"), name };
  state.stations.push(station);
  saveState(state);
  res.json(station);
});

app.post("/api/stations/reorder", (req, res) => {
  const ids = req.body.ids || [];
  if (!Array.isArray(ids) || ids.length !== state.stations.length) return res.status(400).json({ error: "站別清單不完整" });
  const byId = Object.fromEntries(state.stations.map(s => [s.id, s]));
  const reordered = ids.map(id => byId[id]).filter(Boolean);
  if (reordered.length !== state.stations.length) return res.status(400).json({ error: "站別清單不一致" });
  state.stations = reordered;
  saveState(state);
  res.json(state.stations);
});

app.delete("/api/stations/:id", (req, res) => {
  state.stations = state.stations.filter(s => s.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

app.post("/api/exceptiontypes", (req, res) => {
  const type = (req.body.type || "").trim();
  const targetStationName = req.body.targetStationName;
  if (!type) return res.status(400).json({ error: "請輸入問題類型" });
  if (!findStation(targetStationName)) return res.status(400).json({ error: "後續處理站別不存在" });
  if (findExType(type)) return res.status(400).json({ error: "此問題類型已存在" });
  const ex = { id: uid("ex"), type, targetStationName };
  state.exceptionTypes.push(ex);
  saveState(state);
  res.json(ex);
});

app.delete("/api/exceptiontypes/:id", (req, res) => {
  state.exceptionTypes = state.exceptionTypes.filter(e => e.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

/* Supplements the rule-based checks in PFMLogic.runDiagnostics (which are
   exact/deterministic — product exists, qty within limits, etc.) with an AI
   pass over things rules can't judge: typos in station/problem-type names,
   ambiguous phrasing, or numbers that look "off" without breaking a hard
   rule. Never the sole gate — the rule engine still runs regardless. */
app.post("/api/ai-review", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "尚未設定 ANTHROPIC_API_KEY，AI 複核功能未啟用。" });
  }
  const text = (req.body.text || "").toString();
  if (!text.trim()) return res.status(400).json({ error: "缺少要複核的內容" });
  if (text.length > AI_REVIEW_MAX_LENGTH) {
    return res.status(400).json({ error: `內容過長，單次最多 ${AI_REVIEW_MAX_LENGTH} 字（目前 ${text.length} 字）。` });
  }

  const limit = checkAiReviewRateLimit(req.ip);
  if (!limit.ok) {
    return res.status(429).json({ error: `AI 複核已達每小時 ${AI_REVIEW_RATE_LIMIT} 次上限，請約 ${limit.retryAfterMinutes} 分鐘後再試。` });
  }

  const activeWOs = state.workOrders
    .map(w => ({ wo: w, prog: PFMLogic.woProgress(state, w.id) }))
    .filter(x => x.prog.currentLabel !== "已完工");

  const context = [
    `已設定產品：${state.products.map(p => p.name).join("、") || "（無）"}`,
    `已設定站別（依序）：${state.stations.map(s => s.name).join(" → ") || "（無）"}`,
    `已設定問題類型與後續站別：${state.exceptionTypes.map(e => `${e.type}→${e.targetStationName}`).join("、") || "（無）"}`,
    `生產中的工單：${activeWOs.map(x => `${x.wo.no}（目前應於「${x.prog.currentLabel}」過站，預計 ${x.wo.plannedQty} 件，已完成 ${x.prog.completed} 件）`).join("；") || "（無）"}`,
  ].join("\n");

  const prompt = `你是生產流程管理系統的複核助手。系統已經有一套規則引擎會檢查「產品/工單是否存在、數量是否超過可過站數量、站別順序是否正確」這類有標準答案的規則，你不需要重複做這些。

你的工作是找出規則引擎抓不到、但看起來可疑的地方，例如：
- 使用者輸入的站別、問題類型名稱，跟系統裡設定的名稱很像但拼法不同（可能是打錯字或簡稱）
- 語意不清楚、有缺漏、或跟現有生產中工單的狀態對不起來的地方
- 數量、日期等數字看起來不合理（但不一定違反明確規則）

系統目前資料：
${context}

使用者輸入的原始內容：
"""
${text}
"""

請用繁體中文，最多 3 條，簡短條列你發現的疑慮。如果沒有發現任何額外疑慮，就只回覆「內容看起來清楚，未發現規則引擎之外的疑慮。」不要加開場白或結語。`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || "呼叫 AI 複核失敗" });
    }
    const review = data.content?.[0]?.text || "(無回應內容)";
    res.json({ review });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* The one endpoint where two people acting at nearly the same time can
   genuinely conflict (both trying to move qty through the same station) —
   re-validate against the server's own current state, not whatever the
   client had cached, using the same PFMLogic the UI uses. */
app.post("/api/records", (req, res) => {
  const { workOrderId, operator, station, type, reason, problemType, targetStation, date, time } = req.body;
  const qty = parseInt(req.body.qty, 10);

  const wo = findWO(workOrderId);
  if (!wo) return res.status(400).json({ error: "工單不存在" });
  if (!(operator || "").trim()) return res.status(400).json({ error: "請填寫操作人員" });
  const st = findStation(station);
  if (!st) return res.status(400).json({ error: "站別不存在" });
  if (!qty || qty <= 0) return res.status(400).json({ error: "數量須為正整數" });
  if (!["normal", "skip", "exception"].includes(type)) return res.status(400).json({ error: "過站類型不正確" });

  const prog = PFMLogic.woProgress(state, wo.id);
  if (prog.currentLabel === "已完工") return res.status(400).json({ error: "此工單已完工，不可再登記過站" });

  if (type === "skip") {
    if (!(reason || "").trim()) return res.status(400).json({ error: "跳站需填寫原因" });
    const avail = PFMLogic.totalInProcess(state, wo.id);
    if (qty > avail) return res.status(400).json({ error: `數量超過工單目前總在製數量（目前在製 ${avail} 件）` });
  } else if (type === "exception") {
    if (!(problemType || "").trim()) return res.status(400).json({ error: "請選擇問題類型" });
    if (!findStation(targetStation)) return res.status(400).json({ error: "問題類型尚未對應後續站別" });
    const avail = PFMLogic.available(state, wo.id, station);
    if (qty > avail) return res.status(400).json({ error: `數量超過「${station}」可過站數量（目前可用 ${avail} 件）` });
  } else {
    const expected = prog.queues.length ? prog.queues[0].name : prog.seq[0];
    const isExceptionReceive = prog.pendingExceptions.some(e => e.targetStation === station);
    if (expected && station !== expected && !isExceptionReceive) {
      return res.status(400).json({ error: `目前應於「${expected}」過站，若確定要跳至「${station}」請改用跳站並填寫原因` });
    }
    const avail = PFMLogic.available(state, wo.id, station);
    if (qty > avail) return res.status(400).json({ error: `數量超過「${station}」可過站數量（目前可用 ${avail} 件）` });
  }

  const product = findProduct(wo.productId);
  const rec = {
    id: uid("rec"), workOrderId: wo.id, productName: product ? product.name : "",
    operator: operator.trim(), station, qty, type,
    reason: reason || "", problemType: problemType || "", targetStation: targetStation || "",
    date: date || new Date().toISOString().slice(0, 10),
    time: time || new Date().toTimeString().slice(0, 5),
    createdAt: Date.now(), superseded: false, received: type !== "exception",
  };
  state.records.push(rec);
  saveState(state);
  res.json(rec);
});

app.post("/api/records/:id/correct", (req, res) => {
  const rec = state.records.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "找不到此紀錄" });
  const correctedBy = (req.body.correctedBy || "").trim();
  const qty = parseInt(req.body.qty, 10);
  if (!correctedBy) return res.status(400).json({ error: "請填寫更正人員" });
  if (!qty || qty <= 0) return res.status(400).json({ error: "數量須為正整數" });

  rec.superseded = true;
  const corrected = Object.assign({}, rec, {
    id: uid("rec"), station: req.body.station || rec.station, qty,
    operator: (req.body.operator || rec.operator).trim(), superseded: false,
    correctionOf: rec.id, correctedBy, correctedAt: Date.now(), createdAt: rec.createdAt,
  });
  state.records.push(corrected);
  saveState(state);
  res.json(corrected);
});

app.post("/api/records/:id/receive", (req, res) => {
  const rec = state.records.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "找不到此紀錄" });
  rec.received = true;
  saveState(state);
  res.json(rec);
});

app.listen(PORT, () => {
  console.log(`生產流程管理系統伺服器已啟動`);
  console.log(`本機瀏覽：http://localhost:${PORT}`);
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`同網段其他裝置瀏覽：http://${net.address}:${PORT}`);
      }
    }
  }
});
