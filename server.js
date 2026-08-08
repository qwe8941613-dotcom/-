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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
