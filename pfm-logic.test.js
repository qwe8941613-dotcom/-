const test = require("node:test");
const assert = require("node:assert/strict");
const Logic = require("./pfm-logic.js");

function baseCtx() {
  return {
    products: [{ id: "p1", name: "80CS", spec: "", processId: "proc1" }],
    workOrders: [{ id: "wo1", no: "WO-20260808-01", productId: "p1", plannedQty: 100, status: "in_progress", createdAt: 1 }],
    stations: [
      { id: "s1", name: "接 Block" },
      { id: "s2", name: "清洗站" },
      { id: "s3", name: "檢驗站" },
      { id: "s4", name: "包裝站" },
    ],
    processes: [
      { id: "proc1", name: "標準製程", stationIds: ["s1", "s2", "s3", "s4"] },
    ],
    exceptionTypes: [
      { id: "e1", type: "Block 不良", targetStationName: "清洗站" },
      { id: "e2", type: "尺寸不符", targetStationName: "檢驗站" },
    ],
    records: [],
  };
}

function rec(overrides) {
  return Object.assign({
    id: "r" + Math.random(), workOrderId: "wo1", productName: "80CS", operator: "王小明",
    station: "接 Block", qty: 10, type: "normal", reason: "", problemType: "", targetStation: "",
    date: "2026-08-08", time: "10:00", createdAt: Date.now(), superseded: false, received: true,
  }, overrides);
}

test("replay: fresh work order queues its full planned qty at the first station", () => {
  const ctx = baseCtx();
  const r = Logic.replay(ctx, "wo1");
  assert.equal(r.arrived["接 Block"], 100);
  assert.equal(Logic.available(ctx, "wo1", "接 Block"), 100);
  assert.equal(Logic.available(ctx, "wo1", "清洗站"), 0);
});

test("replay: a normal pass moves qty from the current station to the next", () => {
  const ctx = baseCtx();
  ctx.records.push(rec({ station: "接 Block", qty: 20, type: "normal" }));
  assert.equal(Logic.available(ctx, "wo1", "接 Block"), 80);
  assert.equal(Logic.available(ctx, "wo1", "清洗站"), 20);
});

test("replay: a normal pass through the last station counts as completed, not queued", () => {
  const ctx = baseCtx();
  ctx.records.push(rec({ station: "接 Block", qty: 100, type: "normal" }));
  ctx.records.push(rec({ station: "清洗站", qty: 100, type: "normal" }));
  ctx.records.push(rec({ station: "檢驗站", qty: 100, type: "normal" }));
  ctx.records.push(rec({ station: "包裝站", qty: 100, type: "normal" }));
  const prog = Logic.woProgress(ctx, "wo1");
  assert.equal(prog.completed, 100);
  assert.equal(prog.currentLabel, "已完工");
  assert.equal(prog.pct, 100);
});

test("replay: an exception routes its qty to the target station's queue and is tracked as pending", () => {
  const ctx = baseCtx();
  ctx.records.push(rec({ station: "接 Block", qty: 20, type: "exception", problemType: "Block 不良", targetStation: "清洗站", received: false }));
  const prog = Logic.woProgress(ctx, "wo1");
  assert.equal(Logic.available(ctx, "wo1", "清洗站"), 20);
  assert.equal(prog.pendingExceptions.length, 1);
  assert.equal(prog.pendingExceptions[0].targetStation, "清洗站");
});

test("replay: a superseded (corrected-away) record is excluded so quantity is not double-counted", () => {
  const ctx = baseCtx();
  ctx.records.push(rec({ id: "orig", station: "接 Block", qty: 20, type: "normal", superseded: true }));
  ctx.records.push(rec({ id: "fixed", station: "接 Block", qty: 35, type: "normal", correctionOf: "orig" }));
  assert.equal(Logic.available(ctx, "wo1", "接 Block"), 65);
  assert.equal(Logic.available(ctx, "wo1", "清洗站"), 35);
});

test("runDiagnostics: a well-formed normal pass reports no failures", () => {
  const ctx = baseCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "接 Block", qty: "20" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.equal(result.diags.filter(d => d.status === "fail").length, 0);
  assert.equal(result.looksAbnormal, false);
});

test("runDiagnostics: unknown product is flagged", () => {
  const ctx = baseCtx();
  const fields = { product: "不存在的產品", workOrder: "WO-20260808-01", operator: "王小明", station: "接 Block", qty: "20" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("查無產品")));
});

test("runDiagnostics: quantity beyond what is available at the station fails", () => {
  const ctx = baseCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "清洗站", qty: "5" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("超過可過站數量")));
});

test("runDiagnostics: skipping the expected station without a reason fails", () => {
  const ctx = baseCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "包裝站", qty: "5" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("跳過必要站別")));
});

test("runDiagnostics: skipping to a later station with a reason is accepted as a warning, not a failure", () => {
  const ctx = baseCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "檢驗站", qty: "5", reason: "設備調整，提前備料" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.equal(result.diags.filter(d => d.status === "fail").length, 0);
  assert.ok(result.diags.some(d => d.status === "warn" && d.title.includes("跳站")));
  assert.equal(result.effectiveType, "skip");
});

test("runDiagnostics: a skip's qty is bounded by the work order's total in-process qty, not the (empty) destination station", () => {
  const ctx = baseCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "檢驗站", qty: "150", reason: "設備調整，提前備料" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("超過可過站數量")));
});

test("replay: a skip draws qty from the current queue and advances past the skip-to station", () => {
  const ctx = baseCtx();
  ctx.records.push(rec({ station: "檢驗站", qty: 30, type: "skip", reason: "設備調整" }));
  assert.equal(Logic.available(ctx, "wo1", "接 Block"), 70);
  assert.equal(Logic.available(ctx, "wo1", "包裝站"), 30);
  assert.equal(Logic.totalInProcess(ctx, "wo1"), 100);
});

test("replay: a skip landing on the last station in sequence counts as completed", () => {
  const ctx = baseCtx();
  ctx.records.push(rec({ station: "包裝站", qty: 40, type: "skip", reason: "急件直送" }));
  const prog = Logic.woProgress(ctx, "wo1");
  assert.equal(prog.completed, 40);
});

test("runDiagnostics: derives the problem type from 結果 when no explicit 問題類型 is given (matches the spec example)", () => {
  const ctx = baseCtx();
  const fields = {
    product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "接 Block",
    qty: "20", result: "Block 不良", followUp: "返回清洗站",
  };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.equal(result.diags.filter(d => d.status === "fail").length, 0);
  assert.equal(result.looksAbnormal, true);
  assert.equal(result.effectiveProblemType, "Block 不良");
  assert.ok(result.diags.some(d => d.status === "pass" && d.title.includes("異常分支設定正確")));
});

test("runDiagnostics: abnormal result with no configured exception branch fails", () => {
  const ctx = baseCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "接 Block", qty: "20", result: "未知瑕疵" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("尚未設定分支")));
});

test("runDiagnostics: a completed work order rejects further transit", () => {
  const ctx = baseCtx();
  ["接 Block", "清洗站", "檢驗站", "包裝站"].forEach(st => ctx.records.push(rec({ station: st, qty: 100, type: "normal" })));
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "包裝站", qty: "5" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("已完工")));
});

test("parseFreeText: extracts labelled fields regardless of full-width colon and label synonyms", () => {
  const text = [
    "產品名稱：80CS", "工單號碼：WO-20260808-01", "操作人員：王小明",
    "目前站別：接 Block", "本次完成數量：20件", "結果：Block 不良", "後續處理：清洗站",
  ].join("\n");
  const fields = Logic.parseFreeText(text);
  assert.equal(fields.product, "80CS");
  assert.equal(fields.workOrder, "WO-20260808-01");
  assert.equal(fields.operator, "王小明");
  assert.equal(fields.station, "接 Block");
  assert.equal(fields.qty, "20件");
  assert.equal(fields.result, "Block 不良");
  assert.equal(fields.followUp, "清洗站");
});

/* ---- 站別積木 / 多製程：不同產品可以各自跑不同的站別組合 ---- */

function multiProcessCtx() {
  const ctx = baseCtx(); // 80CS -> proc1 (接 Block, 清洗站, 檢驗站, 包裝站)
  ctx.stations.push({ id: "s5", name: "鍍膜站" });
  ctx.products.push({ id: "p2", name: "鍍膜件", spec: "", processId: "proc2" });
  ctx.processes.push({ id: "proc2", name: "鍍膜製程", stationIds: ["s5", "s3", "s4"] }); // 鍍膜站 -> 檢驗站 -> 包裝站
  ctx.workOrders.push({ id: "wo2", no: "WO-COAT-01", productId: "p2", plannedQty: 50, status: "in_progress", createdAt: 2 });
  return ctx;
}

test("stationSeq: each process resolves its own ordered sequence from the shared station pool", () => {
  const ctx = multiProcessCtx();
  assert.deepEqual(Logic.stationSeq(ctx, "proc1"), ["接 Block", "清洗站", "檢驗站", "包裝站"]);
  assert.deepEqual(Logic.stationSeq(ctx, "proc2"), ["鍍膜站", "檢驗站", "包裝站"]);
});

test("replay: two work orders for products on different processes don't interfere with each other", () => {
  const ctx = multiProcessCtx();
  ctx.records.push(rec({ workOrderId: "wo1", station: "接 Block", qty: 20, type: "normal" }));
  ctx.records.push(rec({ workOrderId: "wo2", productName: "鍍膜件", station: "鍍膜站", qty: 15, type: "normal" }));

  assert.equal(Logic.available(ctx, "wo1", "清洗站"), 20);
  assert.equal(Logic.available(ctx, "wo1", "檢驗站"), 0); // wo1 走的是 proc1，鍍膜站不在它的序列裡
  assert.equal(Logic.available(ctx, "wo2", "檢驗站"), 15); // wo2 走 proc2，鍍膜站的下一站就是檢驗站
  assert.equal(Logic.available(ctx, "wo2", "清洗站"), 0); // 清洗站根本不在 proc2 裡
});

test("woProgress: a product with no process assigned reports 尚未指定製程 instead of a bogus station", () => {
  const ctx = multiProcessCtx();
  ctx.products[1].processId = null; // 鍍膜件還沒被指定製程
  const prog = Logic.woProgress(ctx, "wo2");
  assert.equal(prog.currentLabel, "尚未指定製程");
  assert.equal(Logic.available(ctx, "wo2", "鍍膜站"), 0);
});

test("runDiagnostics: a work order whose product has no process fails clearly instead of comparing against an empty sequence", () => {
  const ctx = multiProcessCtx();
  ctx.products[1].processId = null;
  const fields = { product: "鍍膜件", workOrder: "WO-COAT-01", operator: "王小明", station: "鍍膜站", qty: "10" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.ok(result.diags.some(d => d.status === "fail" && d.title.includes("尚未指定製程")));
  // Only one complaint about it — the station-sequence check shouldn't also
  // fire a second, confusing "expected: (nothing)" failure on top.
  assert.equal(result.diags.filter(d => d.title.includes("跳過必要站別")).length, 0);
});

test("runDiagnostics: a station that exists as a block but isn't part of this product's process is treated as a skip", () => {
  const ctx = multiProcessCtx();
  const fields = { product: "80CS", workOrder: "WO-20260808-01", operator: "王小明", station: "鍍膜站", qty: "10", reason: "臨時加工" };
  const result = Logic.runDiagnostics(ctx, fields);
  assert.equal(result.diags.filter(d => d.status === "fail").length, 0);
  assert.equal(result.effectiveType, "skip");
});
