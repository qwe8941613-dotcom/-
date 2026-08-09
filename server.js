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
const ASSISTANT_MAX_LENGTH = 2000;
const ASSISTANT_RATE_LIMIT = 20; // 每 IP 每小時，跟 ai-chat-web 用同一套邏輯
const ASSISTANT_RATE_WINDOW_MS = 60 * 60 * 1000;
const ASSISTANT_MAX_HISTORY = 20; // 只記住最近 20 則對話（使用者+AI 合計）

// 部署在 Render 這類平台時，真正的訪客 IP 在 X-Forwarded-For 裡。
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const assistantRateBuckets = new Map();
function checkAssistantRateLimit(ip) {
  const now = Date.now();
  const entry = assistantRateBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    assistantRateBuckets.set(ip, { count: 1, resetAt: now + ASSISTANT_RATE_WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= ASSISTANT_RATE_LIMIT) {
    return { ok: false, retryAfterMinutes: Math.max(1, Math.ceil((entry.resetAt - now) / 60000)) };
  }
  entry.count += 1;
  return { ok: true };
}

// sessionId -> 最近訊息陣列（多輪對話記憶，只存在記憶體，重啟就清空）
const assistantConversations = new Map();
function getAssistantHistory(sessionId) {
  return assistantConversations.get(sessionId) || [];
}
function appendAssistantHistory(sessionId, entries) {
  const trimmed = getAssistantHistory(sessionId).concat(entries).slice(-ASSISTANT_MAX_HISTORY);
  assistantConversations.set(sessionId, trimmed);
}

function buildSystemContext() {
  const activeWOs = state.workOrders
    .map(w => ({ wo: w, prog: PFMLogic.woProgress(state, w.id) }));

  const processLines = (state.processes || []).map(proc =>
    `「${proc.name}」：${PFMLogic.stationSeq(state, proc.id).join(" → ") || "（尚未加入站別）"}`
  ).join("；") || "（無）";

  const productLines = state.products.map(p => {
    const proc = PFMLogic.processById(state, p.processId);
    return `${p.name}（走「${proc ? proc.name : "尚未指定製程"}」）`;
  }).join("、") || "（無）";

  return [
    `已設定產品：${productLines}`,
    `已設定站別積木：${state.stations.map(s => s.name).join("、") || "（無）"}`,
    `已設定製程（各自的站別順序）：${processLines}`,
    `已設定分流原因與後續站別：${state.exceptionTypes.map(e => `${e.type}→${e.targetStationName}`).join("、") || "（無）"}`,
    `所有工單狀態：${activeWOs.map(x => `${x.wo.no}／產品 ${(findProduct(x.wo.productId) || {}).name || "未知"}／${x.prog.currentLabel === "已完工" ? "已完工" : `目前應於「${x.prog.currentLabel}」過站`}／預計 ${x.wo.plannedQty} 件／已完成 ${x.prog.completed} 件`).join("；") || "（無）"}`,
    `等待接收的分流：${state.records.filter(r => r.type === "exception" && !r.superseded && !r.received).map(r => `${r.productName}於「${r.station}」發生「${r.problemType}」，${r.qty} 件，等待「${r.targetStation}」接收`).join("；") || "（無）"}`,
  ].join("\n");
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  const p1 = uid("p");
  const wo1 = uid("wo");
  const st1 = uid("st"), st2 = uid("st"), st3 = uid("st"), st4 = uid("st");
  const proc1 = uid("proc");
  return {
    products: [{ id: p1, name: "80CS", spec: "", processId: proc1 }],
    workOrders: [{ id: wo1, no: "WO-20260808-01", productId: p1, plannedQty: 100, status: "in_progress", createdAt: Date.now(), createdBy: "系統預設" }],
    stations: [
      { id: st1, name: "接 Block" },
      { id: st2, name: "清洗站" },
      { id: st3, name: "檢驗站" },
      { id: st4, name: "包裝站" },
    ],
    processes: [
      { id: proc1, name: "標準製程", stationIds: [st1, st2, st3, st4] },
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
      if (parsed.products && parsed.stations) {
        if (!parsed.processes) parsed.processes = []; // 舊資料檔沒有製程概念，補一個空陣列
        return parsed;
      }
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
function findProcess(id) { return state.processes.find(p => p.id === id); }

app.get("/api/state", (req, res) => {
  res.json(state);
});

app.post("/api/products", (req, res) => {
  const name = (req.body.name || "").trim();
  const spec = (req.body.spec || "").trim();
  const processId = req.body.processId || null;
  if (!name) return res.status(400).json({ error: "請輸入產品名稱" });
  if (state.products.some(p => p.name === name)) return res.status(400).json({ error: "此產品名稱已存在" });
  if (processId && !findProcess(processId)) return res.status(400).json({ error: "指定的製程不存在" });
  const product = { id: uid("p"), name, spec, processId };
  state.products.push(product);
  saveState(state);
  res.json(product);
});

app.post("/api/products/:id/process", (req, res) => {
  const product = findProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "找不到此產品" });
  const processId = req.body.processId || null;
  if (processId && !findProcess(processId)) return res.status(400).json({ error: "指定的製程不存在" });
  product.processId = processId;
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
  // 站別積木被刪除了，順帶從所有製程的排序裡拿掉，避免製程裡卡著一個不存在的站。
  state.processes.forEach(proc => { proc.stationIds = proc.stationIds.filter(id => id !== req.params.id); });
  saveState(state);
  res.json({ ok: true });
});

/* ---- 製程（把站別積木排成一條產品要跑的流程） ---- */
app.post("/api/processes", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "請輸入製程名稱" });
  if (state.processes.some(p => p.name === name)) return res.status(400).json({ error: "此製程名稱已存在" });
  const proc = { id: uid("proc"), name, stationIds: [] };
  state.processes.push(proc);
  saveState(state);
  res.json(proc);
});

app.delete("/api/processes/:id", (req, res) => {
  if (state.products.some(p => p.processId === req.params.id)) {
    return res.status(400).json({ error: "仍有產品使用此製程，請先改指定其他製程後再刪除" });
  }
  state.processes = state.processes.filter(p => p.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

app.post("/api/processes/:id/stations", (req, res) => {
  const proc = findProcess(req.params.id);
  if (!proc) return res.status(404).json({ error: "找不到此製程" });
  const stationId = req.body.stationId;
  if (!state.stations.some(s => s.id === stationId)) return res.status(400).json({ error: "站別不存在" });
  // 同一個站別積木可以在同一條製程裡出現不只一次（例如去而復返），所以不擋重複。
  proc.stationIds.push(stationId);
  saveState(state);
  res.json(proc);
});

app.post("/api/processes/:id/stations/reorder", (req, res) => {
  const proc = findProcess(req.params.id);
  if (!proc) return res.status(404).json({ error: "找不到此製程" });
  const ids = req.body.stationIds || [];
  if (!Array.isArray(ids) || ids.length !== proc.stationIds.length) return res.status(400).json({ error: "站別清單不完整" });
  // 站別可以重複，所以用「排序後逐一比對」確認是同一組積木（含重複次數），
  // 而不是只檢查每個 id 有沒有出現過──否則可能被偷換掉某個重複的站別。
  const sortedOld = [...proc.stationIds].sort();
  const sortedNew = [...ids].sort();
  const same = sortedOld.length === sortedNew.length && sortedOld.every((id, i) => id === sortedNew[i]);
  if (!same) return res.status(400).json({ error: "站別清單不一致" });
  proc.stationIds = ids;
  saveState(state);
  res.json(proc);
});

app.delete("/api/processes/:id/stations/:stationId", (req, res) => {
  const proc = findProcess(req.params.id);
  if (!proc) return res.status(404).json({ error: "找不到此製程" });
  // 站別可能在同一條製程裡重複出現，所以優先用呼叫端指定的位置（index）刪除
  // 那一個特定的積木；沒給位置時退回刪除第一個符合的，維持舊行為相容。
  const idx = req.query.index !== undefined ? parseInt(req.query.index, 10) : proc.stationIds.indexOf(req.params.stationId);
  if (!(idx >= 0) || proc.stationIds[idx] !== req.params.stationId) return res.status(400).json({ error: "站別位置不正確" });
  proc.stationIds.splice(idx, 1);
  saveState(state);
  res.json(proc);
});

app.post("/api/exceptiontypes", (req, res) => {
  const type = (req.body.type || "").trim();
  const targetStationName = req.body.targetStationName;
  if (!type) return res.status(400).json({ error: "請輸入分流原因" });
  if (!findStation(targetStationName)) return res.status(400).json({ error: "後續處理站別不存在" });
  if (findExType(type)) return res.status(400).json({ error: "此分流原因已存在" });
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

/* Read-only Q&A assistant over the live system state — "現在鍍膜有排工單嗎"
   這類問題。它只能回答/查詢，不會建立或修改任何紀錄；真正的過站登記、修正
   一律還是要走各自頁面的表單（工單清單點選登記過站／修正紀錄頁面），走過
   PFMLogic 的驗證。 */
app.post("/api/assistant/chat", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "尚未設定 ANTHROPIC_API_KEY，AI 助理功能未啟用。" });
  }
  const message = (req.body.message || "").toString();
  const sessionId = (req.body.sessionId || "").toString();
  if (!message.trim()) return res.status(400).json({ error: "缺少訊息內容" });
  if (!sessionId) return res.status(400).json({ error: "缺少 sessionId" });
  if (message.length > ASSISTANT_MAX_LENGTH) {
    return res.status(400).json({ error: `訊息過長，單次最多 ${ASSISTANT_MAX_LENGTH} 字（目前 ${message.length} 字）。` });
  }

  const limit = checkAssistantRateLimit(req.ip);
  if (!limit.ok) {
    return res.status(429).json({ error: `已達每小時 ${ASSISTANT_RATE_LIMIT} 次的使用上限，請約 ${limit.retryAfterMinutes} 分鐘後再試。` });
  }

  const systemPrompt = `你是生產流程管理系統的查詢助理，只回答關於目前系統資料的問題（工單進度、站別狀態、分流紀錄等），語氣簡短直接。

規則：
- 只能根據下面提供的「系統目前資料」回答，不可以編造資料中沒有的內容
- 如果使用者問的產品、站別、工單不在系統資料中，直接告知「系統目前沒有登記這項資料」，不要用一般常識回答
- 如果使用者想要「登記過站」「新增工單」「修改資料」這類會改變系統狀態的操作，告訴他這裡只能查詢，登記過站請到「產品 / 工單」頁面點選該筆工單，修改紀錄請至「修正紀錄」頁面，不要嘗試自己執行
- 用繁體中文回答，盡量簡短
- 不要使用 markdown 語法（例如 ** 粗體、# 標題），畫面只會顯示純文字，星號會直接被看到

系統目前資料：
${buildSystemContext()}`;

  const history = getAssistantHistory(sessionId);
  const userEntry = { role: "user", content: message };

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
        max_tokens: 500,
        system: systemPrompt,
        messages: [...history, userEntry],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || "呼叫 AI 助理失敗" });
    }
    const reply = data.content?.[0]?.text || "(無回應內容)";
    appendAssistantHistory(sessionId, [userEntry, { role: "assistant", content: reply }]);
    res.json({ reply });
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
  if (!prog.process) return res.status(400).json({ error: "此工單的產品尚未指定製程，請先至「站別設定」建立製程並在「產品/工單」指定" });
  if (prog.currentLabel === "已完工") return res.status(400).json({ error: "此工單已完工，不可再登記過站" });

  if (type === "skip") {
    if (!(reason || "").trim()) return res.status(400).json({ error: "跳站需填寫原因" });
    const avail = PFMLogic.totalInProcess(state, wo.id);
    if (qty > avail) return res.status(400).json({ error: `數量超過工單目前總在製數量（目前在製 ${avail} 件）` });
  } else if (type === "exception") {
    if (!(problemType || "").trim()) return res.status(400).json({ error: "請選擇分流原因" });
    if (!findStation(targetStation)) return res.status(400).json({ error: "分流原因尚未對應後續站別" });
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
