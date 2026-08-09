/* Pure production-flow business logic, shared by the app (pfm.html) and its
   test suite (pfm-logic.test.js). Every function takes an explicit `ctx`
   ({ products, workOrders, stations, processes, exceptionTypes, records })
   instead of reading global state, so it can run identically in the browser
   or Node.

   Stations are reusable "building blocks" (just an id + name). A 製程
   (process) is a named, ordered arrangement of those blocks — its
   `stationIds` array IS the sequence. Each product is assigned to exactly
   one process (`product.processId`); a work order's applicable sequence is
   resolved via its product's process, so different products can run
   different flows built from the same shared station pool. */

const ABNORMAL_KEYWORDS = ["不良", "異常", "NG", "ng", "故障", "報廢", "退回", "不合格", "瑕疵"];

const FIELD_LABELS = {
  product: ["產品名稱", "產品"], workOrder: ["工單號碼", "工單"], operator: ["操作人員", "人員", "作業人員"],
  station: ["目前站別", "發生站別", "站別"], qty: ["本次完成數量", "異常數量", "完成數量", "數量"],
  result: ["結果"], problemType: ["問題類型"], followUp: ["後續處理", "後續站別", "後續"],
  reason: ["原因", "跳站原因"], date: ["日期"], time: ["時間"],
};

function productById(ctx, id) { return ctx.products.find(p => p.id === id); }
function productByName(ctx, name) { return ctx.products.find(p => p.name === name); }
function woById(ctx, id) { return ctx.workOrders.find(w => w.id === id); }
function woByNo(ctx, no) { return ctx.workOrders.find(w => w.no === no); }
function stationById(ctx, id) { return ctx.stations.find(s => s.id === id); }
function stationByName(ctx, name) { return ctx.stations.find(s => s.name === name); }
function exTypeByName(ctx, name) { return ctx.exceptionTypes.find(e => e.type === name); }
function processById(ctx, id) { return (ctx.processes || []).find(p => p.id === id); }
function processByName(ctx, name) { return (ctx.processes || []).find(p => p.name === name); }

// The ordered station-name sequence a given process defines. Unknown/missing
// process (not yet assigned, or deleted out from under a product) yields an
// empty sequence — callers treat that as "nothing to do yet", not a crash.
function stationSeq(ctx, processId) {
  const proc = processById(ctx, processId);
  if (!proc) return [];
  return proc.stationIds.map(id => (stationById(ctx, id) || {}).name).filter(Boolean);
}

// Resolves the process a work order actually runs through, via its product.
function processForWO(ctx, wo) {
  if (!wo) return null;
  const product = productById(ctx, wo.productId);
  return product ? processById(ctx, product.processId) : null;
}

function activeRecordsFor(ctx, woId) {
  return ctx.records.filter(r => r.workOrderId === woId && !r.superseded).sort((a, b) => a.createdAt - b.createdAt);
}

// A station block can appear more than once in the same process (e.g. a
// batch that visits 接 Block, then comes back to it later). Tracking by
// station NAME alone can't tell those occurrences apart, so `arrived`/
// `departed` below are keyed by SEQUENCE POSITION (index), not name. Given a
// station name, the "active" occurrence is the earliest position holding
// that name with qty still sitting there — first-in-line, matching how a
// linear process actually drains.
function findActiveIndex(seq, arrived, departed, stationName) {
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== stationName) continue;
    if (((arrived[i] || 0) - (departed[i] || 0)) > 0) return i;
  }
  return -1;
}

/* Replay a work order's records against its product's process sequence to
   derive per-station queue levels, completed qty and current position. */
function replay(ctx, woId) {
  const wo = woById(ctx, woId);
  const proc = processForWO(ctx, wo);
  const seq = stationSeq(ctx, proc ? proc.id : null);
  const arrived = {}, departed = {}; // keyed by index into `seq`
  if (seq.length) arrived[0] = wo ? wo.plannedQty : 0;
  let completed = 0;
  const pendingExceptions = [];
  const log = activeRecordsFor(ctx, woId);
  log.forEach(r => {
    if (r.type === "normal") {
      const idx = findActiveIndex(seq, arrived, departed, r.station);
      if (idx < 0) return; // no active occurrence had qty — shouldn't happen for validated records
      departed[idx] = (departed[idx] || 0) + r.qty;
      if (idx === seq.length - 1) { completed += r.qty; }
      else { arrived[idx + 1] = (arrived[idx + 1] || 0) + r.qty; }
    } else if (r.type === "skip") {
      // Nothing has "arrived" at the skip-to station through the normal
      // sequence, so the qty is drawn from wherever the batch currently
      // sits (earliest active position first), then behaves like a normal
      // pass from the skip-to station onward.
      let remaining = r.qty;
      for (let i = 0; i < seq.length && remaining > 0; i++) {
        const here = Math.max((arrived[i] || 0) - (departed[i] || 0), 0);
        if (here <= 0) continue;
        const take = Math.min(here, remaining);
        departed[i] = (departed[i] || 0) + take;
        remaining -= take;
      }
      const idx = seq.indexOf(r.station); // skip target: first occurrence of that name
      if (idx >= 0 && idx === seq.length - 1) { completed += r.qty; }
      else if (idx >= 0) { arrived[idx + 1] = (arrived[idx + 1] || 0) + r.qty; }
    } else if (r.type === "exception") {
      const fromIdx = findActiveIndex(seq, arrived, departed, r.station);
      if (fromIdx >= 0) departed[fromIdx] = (departed[fromIdx] || 0) + r.qty;
      const toIdx = seq.indexOf(r.targetStation); // first occurrence of the target name
      if (toIdx >= 0) arrived[toIdx] = (arrived[toIdx] || 0) + r.qty;
      pendingExceptions.push(r);
    }
  });
  const queues = seq.map((name, idx) => ({ name, idx, qty: Math.max((arrived[idx] || 0) - (departed[idx] || 0), 0) }))
    .filter(q => q.qty > 0);
  return { seq, process: proc || null, arrived, departed, completed, queues, pendingExceptions, log };
}

function available(ctx, woId, station) {
  const r = replay(ctx, woId);
  const idx = findActiveIndex(r.seq, r.arrived, r.departed, station);
  return idx < 0 ? 0 : Math.max((r.arrived[idx] || 0) - (r.departed[idx] || 0), 0);
}

// Total qty still "in process" somewhere in the work order's queues. Used to
// bound a skip's quantity, since a skip-to station has no "arrived" qty of
// its own to check against — the batch is drawn from wherever it sits.
function totalInProcess(ctx, woId) {
  return replay(ctx, woId).queues.reduce((sum, q) => sum + q.qty, 0);
}

function woProgress(ctx, woId) {
  const wo = woById(ctx, woId);
  const r = replay(ctx, woId);
  const pct = wo && wo.plannedQty ? Math.min(100, Math.round((r.completed / wo.plannedQty) * 100)) : 0;
  let currentLabel;
  if (!r.process) currentLabel = "尚未指定製程";
  else if (r.completed >= (wo ? wo.plannedQty : 0) && wo && wo.plannedQty > 0) currentLabel = "已完工";
  else if (r.queues.length) currentLabel = r.queues.map(q => q.name).join(" / ");
  else currentLabel = r.seq[0] || "尚未設站";
  return { ...r, pct, currentLabel };
}

function parseFreeText(text) {
  const fields = {};
  const lines = text.split(/\r?\n/);
  lines.forEach(line => {
    const m = line.match(/^\s*[◆\-\*•]?\s*([^:：]{1,12})[:：]\s*(.+?)\s*$/);
    if (!m) return;
    const rawLabel = m[1].trim(); const value = m[2].trim();
    for (const key in FIELD_LABELS) {
      if (FIELD_LABELS[key].some(lbl => rawLabel === lbl || rawLabel.endsWith(lbl))) {
        fields[key] = value; break;
      }
    }
  });
  return fields;
}

function runDiagnostics(ctx, fields) {
  const diags = [];
  const add = (status, title, msg) => diags.push({ status, title, msg });

  let product = null;
  if (!fields.product) add("fail", "缺少「產品名稱」欄位", "請填寫產品名稱，需先於「產品 / 工單」建立資料才能登記過站。");
  else {
    product = productByName(ctx, fields.product);
    if (!product) add("fail", `查無產品「${fields.product}」`, "此產品尚未建立，請先至「產品 / 工單」新增，或確認名稱是否輸入正確。");
    else add("pass", "產品存在", "已於系統中找到對應產品資料。");
  }

  let wo = null;
  if (!fields.workOrder) add("fail", "缺少「工單號碼」欄位", "每次過站都必須指定工單，請補上工單號碼。");
  else {
    wo = woByNo(ctx, fields.workOrder);
    if (!wo) add("fail", `查無工單「${fields.workOrder}」`, "請確認工單號碼是否輸入正確，或先建立此工單。");
    else if (product && wo.productId !== product.id) add("fail", "工單與產品不相符", `工單「${wo.no}」對應的產品是「${(productById(ctx, wo.productId) || {}).name}」，與輸入的產品「${fields.product}」不一致，請確認是否選錯工單或產品。`);
    else add("pass", "工單存在且與產品相符", "已核對工單資料。");
  }

  let proc = null;
  if (wo) {
    proc = processForWO(ctx, wo);
    if (!proc) add("fail", "此工單的產品尚未指定製程", "請先至「站別設定」建立製程流程，並在「產品 / 工單」為此產品指定所屬製程，才能核對站別順序與數量。");
  }

  let station = null;
  let stationIsSkip = false;
  if (!fields.station) add("fail", "缺少「站別」欄位", "請填寫目前 / 發生站別。");
  else {
    station = stationByName(ctx, fields.station);
    if (!station) add("fail", `站別「${fields.station}」尚未設定`, "請先至「站別設定」建立此站別積木，或確認名稱與已設定站別是否一致（含全形/半形差異）。");
    else if (wo && proc) {
      const prog = woProgress(ctx, wo.id);
      const expected = prog.queues.length ? prog.queues.map(q => q.name) : (prog.seq[0] ? [prog.seq[0]] : []);
      const isExpected = expected.includes(fields.station);
      const isExceptionReceive = prog.pendingExceptions.some(e => e.targetStation === fields.station);
      if (isExpected || isExceptionReceive) { add("pass", "站別符合製程順序", `工單目前應於「${expected.join("、")}」過站，輸入站別相符。`); }
      else {
        if (fields.reason) { stationIsSkip = true; add("warn", "偵測到跳站，已附原因", `目前應於「${expected.join("、")}」過站，但填寫至「${fields.station}」；已記錄跳站原因：「${fields.reason}」。`); }
        else add("fail", "跳過必要站別但未填寫原因", `工單目前應於「${expected.join("、")}」過站，直接填入「${fields.station}」視為跳站，請補上原因欄位，或修正為正確站別。`);
      }
    } else if (wo && !proc) {
      // Already reported above as "尚未指定製程" — avoid a second, redundant complaint.
    } else add("warn", "無法核對站別順序", "缺少有效工單，暫無法比對製程順序。");
  }

  const resultAbnormal = ABNORMAL_KEYWORDS.some(k => (fields.result || "").includes(k));
  const looksAbnormal = !!(fields.problemType || resultAbnormal);
  // The example format often states the problem type only inside "結果"
  // (e.g. 結果：Block 不良) without a separate 問題類型 line — fall back to it.
  let effectiveProblemType = fields.problemType || "";
  if (!effectiveProblemType && resultAbnormal) effectiveProblemType = fields.result;
  if (looksAbnormal) {
    if (!effectiveProblemType) add("fail", "偵測到異常結果但缺少「問題類型」", "結果顯示為異常，請填寫問題類型（或直接於「結果」欄位寫明問題類型）以利分流。");
    else {
      const ex = exTypeByName(ctx, effectiveProblemType);
      if (!ex) add("fail", `問題類型「${effectiveProblemType}」尚未設定分支`, "請先至「站別設定」建立此問題類型對應的後續處理站別，或確認名稱是否與已設定的問題類型一致。");
      else {
        const followUp = fields.followUp || ex.targetStationName;
        const matches = followUp === ex.targetStationName || followUp.includes(ex.targetStationName) || ex.targetStationName.includes(followUp);
        if (!matches) add("warn", "後續站別與設定不符", `問題類型「${effectiveProblemType}」預設應轉入「${ex.targetStationName}」，輸入為「${followUp}」，請確認是否手動調整。`);
        else add("pass", "異常分支設定正確", `問題類型「${effectiveProblemType}」將轉入「${ex.targetStationName}」。`);
      }
    }
  }

  const effectiveType = looksAbnormal ? "exception" : (stationIsSkip ? "skip" : "normal");

  const qtyNum = parseInt(fields.qty, 10);
  if (!fields.qty || isNaN(qtyNum) || qtyNum <= 0) add("fail", "數量錯誤", "數量必須是大於 0 的整數，請確認是否誤填文字、單位或負數。");
  else if (wo && station && proc) {
    // A skip-to station has no "arrived" qty of its own to check against —
    // the batch is drawn from wherever it currently sits — so bound it by
    // the work order's total in-process qty instead of that station's queue.
    const avail = stationIsSkip ? totalInProcess(ctx, wo.id) : available(ctx, wo.id, station.name);
    const availLabel = stationIsSkip ? "工單目前總在製數量" : `「${station.name}」目前可用數量`;
    if (qtyNum > avail) add("fail", "數量超過可過站數量", `${availLabel}為 ${avail} 件，輸入的 ${qtyNum} 件超過上限，請確認是否重複登記或數量填錯。`);
    else add("pass", "數量在可過站範圍內", `${availLabel} ${avail} 件，本次登記 ${qtyNum} 件。`);
  } else add("warn", "數量格式正確，但無法核對上限", "缺少有效工單、站別或製程，暫無法比對可過站數量。");

  if (!fields.date && !fields.time) add("warn", "未填寫日期／時間", "將自動帶入系統目前時間戳記。");
  else add("pass", "日期／時間已提供", "將以輸入內容記錄，仍會保留系統實際送出時間供追查。");

  if (wo) {
    const prog = woProgress(ctx, wo.id);
    if (prog.currentLabel === "已完工") add("fail", "此工單已完工", "已完工工單不得再登記過站，如需更正請至「修正紀錄」。");
  }

  return { diags, product, wo, station, qtyNum, looksAbnormal, effectiveProblemType, effectiveType };
}

const Logic = {
  ABNORMAL_KEYWORDS, FIELD_LABELS,
  productById, productByName, woById, woByNo, stationById, stationByName, exTypeByName,
  processById, processByName, stationSeq, processForWO,
  activeRecordsFor, replay, available, totalInProcess, woProgress, parseFreeText, runDiagnostics,
};

if (typeof module !== "undefined" && module.exports) module.exports = Logic;
if (typeof window !== "undefined") window.PFMLogic = Logic;
