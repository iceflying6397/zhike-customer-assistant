const state = {
  list: null,
  cid: null,
  view: null,
  tab: "brief",
  busy: {}, // "C1:brief" -> 回放进度 {step, elapsed, step_elapsed, notes}
  revealed: new Set(), // 本次已经点过「生成」的 "C1:brief"
  qa: {},
  adopted: {},
  ignored: {},
  resolved: {},
};

const STEPS = {
  brief: ["离线抽取：把每条记录拆成事件", "在线生成：写简报、找冲突、给建议", "引用校验：检查每句话的出处"],
  handover: ["读取已抽取的事件", "生成交接简报和「问前任」清单", "引用校验：检查每句话的出处"],
};
// 生成过程每一步的展示时长（毫秒），结果来自预生成的真实调用
const REPLAY = { brief: [1600, 3400, 1000], handover: [900, 3200, 900] };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `服务返回异常（${res.status}）` }));
  if (!res.ok || data.error) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2800);
}

// 每个客户要先点「生成」才展示结果
function shown(cid, kind, view) {
  return !!view?.[kind] && state.revealed.has(`${cid}:${kind}`);
}

// ---------- 出处 ----------

function cites(sources) {
  if (!sources || !sources.length) return "";
  const payload = esc(JSON.stringify(sources));
  return sources
    .map((s) => `<span class="cite ${s.verified === false ? "unverified" : ""}" data-sources="${payload}" title="点击查看原文">${esc(s.id)}</span>`)
    .join("");
}

function stmt(s) {
  const cls = s.layer === "客户诉求" ? "ask" : s.layer === "AI推断" ? "infer" : "fact";
  const tag = s.layer === "事实" ? "" : `<span class="layer-tag">${s.layer === "AI推断" ? "AI 推断" : "客户诉求"}</span>`;
  return `<div class="stmt ${cls}">${tag}${esc(s.text)}${cites(s.sources)}</div>`;
}

function highlight(text, quote) {
  if (!quote) return esc(text);
  const i = text.indexOf(quote);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(quote) + "</mark>" + esc(text.slice(i + quote.length));
}

function openDrawer(sources) {
  const all = state.view.sources;
  $("#drawer-body").innerHTML = sources
    .map((s) => {
      const src = all[s.id];
      if (!src) return "";
      return `<div class="src">
        <div class="s-label">${esc(src.kind)} · ${esc(src.label)}</div>
        <div class="s-text">${highlight(src.text, s.quote)}</div>
        ${s.verified === false ? `<div class="s-warn">模型给出的摘录与原文不完全一致，已取消高亮，请以原文为准</div>` : ""}
      </div>`;
    })
    .join("");
  $("#drawer").classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  const c = e.target.closest(".cite");
  if (c) openDrawer(JSON.parse(c.dataset.sources));
});
$("#drawer-close").onclick = () => $("#drawer").classList.add("hidden");

// ---------- 顶栏 ----------

// ---------- 左侧客户列表 ----------

function renderSidebar() {
  $("#customer-list").innerHTML = state.list.customers
    .map((c) => {
      const tags = [];
      if (c.new_owner) tags.push(`<span class="pill blue">待交接 ${esc(c.owner)}→${esc(c.new_owner)}</span>`);
      const warns = c.signals.filter((s) => s.level !== "info").length;
      const briefShown = c.has_brief && state.revealed.has(`${c.id}:brief`);
      if (briefShown && c.conflict_count) tags.push(`<span class="pill red">${c.conflict_count} 处待确认</span>`);
      else if (warns) tags.push(`<span class="pill amber">${warns} 个风险信号</span>`);
      return `<li data-id="${c.id}" class="${c.id === state.cid ? "active" : ""}">
        <div class="c-name">${esc(c.short)}</div>
        <div class="c-meta">${esc(c.industry)} · ${c.record_count} 条记录</div>
        <div class="c-tags">${tags.join("")}</div>
      </li>`;
    })
    .join("");
  document.querySelectorAll("#customer-list li").forEach((li) => (li.onclick = () => selectCustomer(li.dataset.id)));
}

async function refreshList() {
  state.list = await api("/data/customers.json");
  renderSidebar();
  const push = await api("/data/push.json");
  const n = push.cards.length;
  $("#push-count").textContent = n;
  $("#push-count").classList.toggle("hidden", !n);
}

async function selectCustomer(cid) {
  if (state.cid !== cid) state.tab = "brief";
  state.cid = cid;
  renderSidebar();
  state.view = await api(`/data/${cid}.json`);
  renderMain();
}

// ---------- 主区域 ----------

const TABS = [
  ["brief", "客户简报"],
  ["ledger", "承诺台账"],
  ["handover", "交接模式"],
  ["qa", "问答"],
  ["records", "原始记录"],
  ["process", "处理过程"],
];

function renderMain() {
  const v = state.view;
  const c = v.customer;
  const a = c.account;
  const signalPills = v.signals
    .map((s) => `<span class="pill ${s.level === "warn" ? "orange" : s.level === "stale" ? "amber" : "blue"}">${esc(s.text)}</span>`)
    .join("");
  const overdue = shown(c.id, "brief", v) ? v.brief.data.commitments.filter((x) => x.status === "已逾期").length : 0;
  $("#main").innerHTML = `
    <div class="c-header">
      <div>
        <h2>${esc(c.name)}</h2>
        <div class="sub">${esc(a.industry)} · ${esc(a.size)} · 合作始于 ${esc(a.since)} · 负责人 ${esc(a.owner)}${a.new_owner ? ` → ${esc(a.new_owner)}` : ""}</div>
      </div>
    </div>
    <div class="signals"><span class="muted" style="font-size:12px">规则检测：</span>${signalPills || '<span class="muted" style="font-size:12px">无</span>'}</div>
    <div class="tabs">${TABS.map(([k, t]) => `<button class="tab ${state.tab === k ? "active" : ""}" data-tab="${k}">${t}${k === "ledger" && overdue ? `<span class="badge">${overdue}</span>` : ""}</button>`).join("")}</div>
    <div id="tab-body"></div>`;
  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderMain(); }));
  renderTab();
}

function renderTab() {
  ({ brief: renderBrief, ledger: renderLedger, handover: renderHandover, qa: renderQA, records: renderRecords, process: renderProcess })[state.tab]();
}

// 结果上方的说明行，末尾是「刷新」：基于数据重新生成这份结果
function metaLine(cache) {
  if (!cache) return "";
  const v = cache.validation || {};
  return `<div class="meta-line">由 ${esc(cache.usage?.model || "")} 生成 · 引用校验：删除无出处内容 ${v.removed || 0} 条，摘录未逐字匹配 ${v.unverified_quotes || 0} 处 · <button class="link-btn" id="regen">刷新</button></div>`;
}

// ---------- 生成：进度展示 ----------

function progressView(kind, p) {
  const steps = STEPS[kind];
  return `<div class="card loading"><div class="prog">
    <h4>${kind === "brief" ? "正在生成客户简报" : "正在生成交接简报"}</h4>
    ${steps.map((s, i) => {
      const st = i < p.step ? "done" : i === p.step ? "on" : "wait";
      const note = p.notes?.[i] || (st === "on" ? `${p.step_elapsed ?? 0} 秒` : "");
      return `<div class="pstep ${st}"><div class="ic">${st === "done" ? "✓" : ""}</div><div><div class="pt">${esc(s)}</div>${note ? `<div class="pd">${esc(note)}</div>` : ""}</div></div>`;
    }).join("")}
    <div class="total">已用时 ${p.elapsed ?? 0} 秒</div>
  </div></div>`;
}

function paintProgress(cid, kind) {
  if (state.cid === cid && state.tab === kind && state.busy[`${cid}:${kind}`]) {
    $("#tab-body").innerHTML = progressView(kind, state.busy[`${cid}:${kind}`]);
  }
}

// 按预生成结果里的真实数据展示生成过程
async function replay(cid, kind) {
  const key = `${cid}:${kind}`;
  const cache = state.view[kind];
  const ev = state.view.events;
  const notes = kind === "brief"
    ? [`${ev ? ev.data.length : 0} 个事件 · ${ev?.usage?.model || ""}`, `${cache.usage?.model || ""}`, `删除无出处内容 ${cache.validation?.removed || 0} 条 · 摘录未逐字匹配 ${cache.validation?.unverified_quotes || 0} 处`]
    : [`${ev ? ev.data.length : 0} 个事件`, `${cache.usage?.model || ""}`, `删除无出处内容 ${cache.validation?.removed || 0} 条`];
  const t0 = Date.now();
  const p = { step: 0, elapsed: 0, step_elapsed: 0, notes: {} };
  state.busy[key] = p;
  for (let i = 0; i < REPLAY[kind].length; i++) {
    p.step = i;
    const s0 = Date.now();
    while (Date.now() - s0 < REPLAY[kind][i]) {
      p.elapsed = Math.round((Date.now() - t0) / 1000);
      p.step_elapsed = Math.round((Date.now() - s0) / 1000);
      paintProgress(cid, kind);
      await sleep(200);
    }
    p.notes[i] = notes[i];
  }
  p.step = REPLAY[kind].length;
  paintProgress(cid, kind);
  await sleep(300);
  delete state.busy[key];
}

async function generate(kind) {
  const cid = state.cid;
  const key = `${cid}:${kind}`;
  if (state.busy[key]) return;
  if (!state.view[kind]) {
    state.lastError = "这个客户还没有生成结果";
    return renderTab();
  }
  state.revealed.delete(key);
  await replay(cid, kind);
  state.revealed.add(key);
  if (state.cid === cid) {
    renderMain();
    if (state.tab === kind) $("#tab-body").classList.add("reveal");
  }
  renderSidebar();
}

function needGenerate(kind, label) {
  const p = state.busy[`${state.cid}:${kind}`];
  if (p) return progressView(kind, p);
  return `<div class="card loading">
    <p>${label}</p>
    <button class="btn primary" id="gen-btn">${kind === "brief" ? "生成客户简报" : "生成交接简报"}</button>
  </div>`;
}

function errorBox() {
  if (!state.lastError) return "";
  const m = state.lastError;
  state.lastError = null;
  return `<div class="error">${esc(m)}</div>`;
}

// ---------- 客户简报 ----------

function renderBrief() {
  const v = state.view;
  const body = $("#tab-body");
  if (!shown(state.cid, "brief", v) || state.busy[`${state.cid}:brief`]) {
    body.innerHTML = errorBox() + needGenerate("brief", "AI 会读完这个客户的全部记录，整理成一页简报，并标出矛盾和过期的信息。");
    const btn = $("#gen-btn");
    if (btn) btn.onclick = () => generate("brief");
    return;
  }
  const b = v.brief;
  const d = b.data;
  body.innerHTML = `
    ${metaLine(b)}
    <div class="card">
      <h3>下一步建议 <span class="muted">采纳后进入待办；忽略可选原因，用于优化建议</span>
</h3>
      ${d.next_actions.map((x, i) => actionCard(x, `a${i}`)).join("") || '<div class="muted">暂无建议</div>'}
    </div>
    <div class="card">
      <h3>需要你确认的问题 <span class="muted">AI 不替你猜，把矛盾和过期的信息摆出来</span></h3>
      ${d.conflicts.map((x, i) => conflictCard(x, `c${i}`)).join("") || '<div class="muted">没有发现矛盾或过期信息</div>'}
    </div>
    <div class="grid2">
      <div class="card"><h3>客户是谁</h3>${d.who.map(stmt).join("")}</div>
      <div class="card"><h3>当前状态</h3>${d.status.map(stmt).join("")}</div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>关键人</h3>
      <div class="people">${d.people.map(personCard).join("")}</div>
    </div>
    <div class="card">
      <h3>合作时间线 <span class="muted">只列关键节点</span></h3>
      <ul class="timeline">${d.timeline.map((t) => `<li><span class="t-date">${esc(t.date)}</span>${esc(t.text)}${cites(t.sources)}</li>`).join("")}</ul>
    </div>`;
  $("#regen").onclick = () => generate("brief");
  bindCards();
}

function actionCard(x, id) {
  const k = `${state.cid}:${id}`;
  const cls = state.adopted[k] ? "adopted" : state.ignored[k] ? "ignored" : "";
  const color = x.priority === "高" ? "red" : x.priority === "中" ? "amber" : "";
  return `<div class="action ${cls}" data-k="${k}">
    <div class="prio"><span class="pill ${color}">${esc(x.priority)}</span></div>
    <div>
      <div class="a-main">${esc(x.action)}</div>
      <div class="a-reason">理由：${esc(x.reason)}${cites(x.sources)}</div>
      <div class="a-btns">
        ${state.adopted[k] ? '<span class="pill green">已加入待办</span>' : state.ignored[k] ? `<span class="pill">已忽略：${esc(state.ignored[k])}</span>` : `
        <button class="btn small primary" data-act="adopt">采纳</button>
        <button class="btn small" data-act="draft">起草跟进消息</button>
        <select class="btn small" data-act="ignore"><option value="">忽略…</option><option>已经做了</option><option>时机不对</option><option>建议不准确</option></select>`}
      </div>
    </div>
  </div>`;
}

function conflictCard(x, id) {
  const k = `${state.cid}:${id}`;
  const done = state.resolved[k];
  return `<div class="conflict k-${esc(x.kind)} ${done ? "resolved" : ""}" data-k="${k}">
    <div class="cf-title"><span class="pill">${esc(x.kind)}</span> ${esc(x.title)}${cites(x.sources)}</div>
    <div class="cf-detail">${esc(x.detail)}</div>
    <div class="cf-sugg">建议：${esc(x.suggestion)}</div>
    <div class="cf-actions">${done ? `<span class="pill green">${esc(done)}</span>` : `
      <button class="btn small primary" data-act="confirm">确认并写回 CRM</button>
      <button class="btn small" data-act="dismiss">信息无误，忽略</button>`}</div>
  </div>`;
}

function personCard(p) {
  const left = p.status === "已离职";
  return `<div class="person ${left ? "left" : ""}">
    <div class="p-name">${esc(p.name)} <span class="pill ${left ? "red" : p.status === "待确认" ? "amber" : "green"}">${esc(p.status)}</span>${cites(p.sources)}</div>
    <div class="p-meta">${esc(p.title)} · ${esc(p.role)}</div>
    <div class="p-meta">态度：${esc(p.attitude)}</div>
    <div class="p-meta">最近出现：${esc(p.last_contact)}</div>
  </div>`;
}

function bindCards() {
  document.querySelectorAll(".action").forEach((el) => {
    const k = el.dataset.k;
    el.querySelector('[data-act="adopt"]')?.addEventListener("click", () => { state.adopted[k] = true; toast("已加入你的待办"); renderTab(); });
    el.querySelector('[data-act="draft"]')?.addEventListener("click", () => toast("跟进消息草稿功能在 V2 规划中（界面示意）"));
    el.querySelector('[data-act="ignore"]')?.addEventListener("change", (e) => { if (e.target.value) { state.ignored[k] = e.target.value; toast("已记录忽略原因，用于优化建议排序"); renderTab(); } });
  });
  document.querySelectorAll(".conflict").forEach((el) => {
    const k = el.dataset.k;
    el.querySelector('[data-act="confirm"]')?.addEventListener("click", () => { state.resolved[k] = "已确认，写回 CRM（演示，未真实写入）"; toast("已生成写回请求，经你确认后更新 CRM（演示）"); renderTab(); });
    el.querySelector('[data-act="dismiss"]')?.addEventListener("click", () => { state.resolved[k] = "已标记为信息无误"; renderTab(); });
  });
}

// ---------- 承诺台账 ----------

function renderLedger() {
  if (!shown(state.cid, "brief", state.view)) { $("#tab-body").innerHTML = `<div class="card muted">先在「客户简报」里生成简报，承诺台账会一起生成。</div>`; return; }
  const b = state.view.brief;
  const order = { 已逾期: 0, 待确认: 1, 进行中: 2, 未开始: 3, 已兑现: 4 };
  const color = { 已逾期: "red", 待确认: "amber", 进行中: "blue", 未开始: "", 已兑现: "green" };
  const rows = [...b.data.commitments].sort((x, y) => order[x.status] - order[y.status]);
  const table = (side) => {
    const rs = rows.filter((r) => r.side === side);
    if (!rs.length) return `<div class="muted">没有记录</div>`;
    return `<table class="ledger"><thead><tr><th>承诺内容</th><th>谁负责</th><th>承诺日期</th><th>截止</th><th>状态</th><th>判断依据</th></tr></thead><tbody>
      ${rs.map((r) => `<tr class="${r.status === "已逾期" ? "overdue" : ""}">
        <td>${esc(r.content)}${cites(r.sources)}</td><td>${esc(r.owner)}</td><td>${esc(r.promised_on)}</td><td>${esc(r.due_date || "—")}</td>
        <td><span class="pill ${color[r.status]}">${esc(r.status)}</span></td><td class="reason">${esc(r.status_reason)}</td></tr>`).join("")}
    </tbody></table>`;
  };
  $("#tab-body").innerHTML = `${metaLine(b)}
    <div class="card"><h3>我方承诺 <span class="muted">答应客户的事</span></h3>${table("我方")}</div>
    <div class="card"><h3>客户承诺 <span class="muted">客户答应我们的事</span></h3>${table("客户")}</div>`;
  $("#regen").onclick = () => generate("brief");
}

// ---------- 交接模式 ----------

function renderHandover() {
  const v = state.view;
  const body = $("#tab-body");
  const a = v.customer.account;
  if (!shown(state.cid, "handover", v) || state.busy[`${state.cid}:handover`]) {
    const label = a.new_owner
      ? `${esc(a.owner)} 即将离职，客户交接给 ${esc(a.new_owner)}。AI 会整理交接简报，并列出需要前任在离开前回答的问题。`
      : "这个客户目前没有交接安排，也可以生成一份交接简报，用于跨团队协作。";
    body.innerHTML = errorBox() + needGenerate("handover", label);
    const btn = $("#gen-btn");
    if (btn) btn.onclick = () => generate("handover");
    return;
  }
  const h = v.handover;
  const d = h.data;
  body.innerHTML = `${metaLine(h)}
    <div class="card"><h3>一句话交接</h3>${d.summary.map(stmt).join("")}</div>
    <div class="grid2">
      <div class="card"><h3>风险与坑</h3>${d.risks.map(stmt).join("")}</div>
      <div class="card"><h3>关系地图</h3>${d.relationships.map(stmt).join("")}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3>第一周该做的事</h3>${d.first_week.map((x, i) => actionCard(x, `h${i}`)).join("")}</div>
    <div class="card"><h3>问前任 <span class="muted">记录里缺失或矛盾的地方，趁 ${esc(a.owner)} 还在，请他补充</span>
      <button class="btn small primary" id="send-q" style="margin-left:auto">发给 ${esc(a.owner)}</button></h3>
      <ol>${d.questions_for_predecessor.map((q) => `<li><b>${esc(q.question)}</b>${cites(q.sources)}<div class="muted" style="font-size:13px">${esc(q.why)}</div></li>`).join("")}</ol>
    </div>`;
  $("#regen").onclick = () => generate("handover");
  $("#send-q").onclick = () => toast(`已发送给 ${a.owner}，回答后自动整理进客户记录（演示）`);
  bindCards();
}

// ---------- 问答 ----------

const QA_STEPS = ["检索相关记录", "生成回答", "校验每句话的出处"];

function renderQA() {
  const list = state.qa[state.cid] || [];
  const sugg = state.view.customer.demo_questions || [];
  $("#tab-body").innerHTML = `
    <div class="card">
      <div class="ask-box"><input id="q" placeholder="问这个客户的任何问题，例如：他们为什么要做二期？"><button class="btn primary" id="ask-btn">提问</button></div>
      <div class="suggests">${sugg.map((s) => `<button class="suggest">${esc(s)}</button>`).join("")}</div>
    </div>
    <div id="qa-list">${list.map(qaItem).join("")}</div>`;
  $("#ask-btn").onclick = () => askQuestion($("#q").value);
  $("#q").onkeydown = (e) => { if (e.key === "Enter") askQuestion(e.target.value); };
  document.querySelectorAll(".suggest").forEach((b) => (b.onclick = () => askQuestion(b.textContent)));
}

function paintQA(cid) {
  if (state.cid === cid && state.tab === "qa") $("#qa-list").innerHTML = (state.qa[cid] || []).map(qaItem).join("");
}

async function askQuestion(q) {
  q = q.trim();
  if (!q) return;
  const cid = state.cid;
  const cached = state.view.qa[q];
  const item = { question: q, pending: true, step: 0, elapsed: 0, live: !cached };
  state.qa[cid] = [item, ...(state.qa[cid] || [])];
  if ($("#q")) $("#q").value = "";
  paintQA(cid);
  const t0 = Date.now();
  const tick = setInterval(() => {
    item.elapsed = Math.round((Date.now() - t0) / 1000);
    if (cached) item.step = Math.min(2, Math.floor((Date.now() - t0) / 900));
    else item.step = item.elapsed < 3 ? 0 : 1;
    paintQA(cid);
  }, 300);
  try {
    // 预设问题直接用已生成的回答；新问题实时调用大模型
    const r = cached || (await api("/api/ask", { method: "POST", body: { cid, question: q } }));
    if (cached) await sleep(Math.max(0, 2700 - (Date.now() - t0)));
    Object.assign(item, r, { pending: false, replayed: !!cached });
  } catch (e) {
    Object.assign(item, { pending: false, error: e.message });
  }
  clearInterval(tick);
  paintQA(cid);
}

function qaItem(r) {
  if (r.pending) {
    return `<div class="card qa"><div class="q">问：${esc(r.question)}</div>
      ${QA_STEPS.map((s, i) => `<div class="pstep ${i < r.step ? "done" : i === r.step ? "on" : "wait"}"><div class="ic">${i < r.step ? "✓" : ""}</div><div class="pt">${s}</div></div>`).join("")}
      <div class="muted" style="font-size:12px">已用时 ${r.elapsed} 秒${r.live ? " · 实时调用大模型" : ""}</div></div>`;
  }
  if (r.error) return `<div class="card qa"><div class="q">问：${esc(r.question)}</div><div class="error">${esc(r.error)}</div></div>`;
  const d = r.data;
  return `<div class="card qa reveal"><div class="q">问：${esc(r.question)}${r.live && !r.replayed ? '<span class="tag-live">实时生成</span>' : ""}</div>
    ${d.statements.map(stmt).join("")}
    ${d.missing_note ? `<div class="missing">${esc(d.missing_note)}</div>` : ""}
    ${r.validation?.removed ? `<div class="meta-line" style="margin:6px 0 0">引用校验删除了 ${r.validation.removed} 句没有出处的内容</div>` : ""}
  </div>`;
}

// ---------- 原始记录 ----------

function renderRecords() {
  const c = state.view.customer;
  $("#tab-body").innerHTML = `
    <div class="card"><h3>这是业务人员原来要读的东西 <span class="muted">老系统里的原始数据，共 ${c.records.length} 条沟通记录</span></h3>
      <table class="ledger"><thead><tr><th>ID</th><th>联系人</th><th>职务</th><th>角色</th><th>资料更新于</th></tr></thead><tbody>
      ${c.contacts.map((p) => `<tr><td>${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.title)}</td><td>${esc(p.role)}</td><td>${esc(p.updated_at)}</td></tr>`).join("")}</tbody></table>
      <table class="ledger" style="margin-top:12px"><thead><tr><th>ID</th><th>商机</th><th>金额</th><th>阶段</th><th>更新于</th></tr></thead><tbody>
      ${c.opportunities.map((o) => `<tr><td>${o.id}</td><td>${esc(o.name)}</td><td>${esc(o.amount)}</td><td>${esc(o.stage)}</td><td>${esc(o.updated_at)}</td></tr>`).join("")}</tbody></table>
    </div>
    <div class="card"><h3>沟通记录</h3>
      ${c.records.map((r) => `<div class="record" id="rec-${r.id}"><div class="r-head"><span class="r-id">${r.id}</span>${esc(r.date)} · ${esc(r.type)} · ${esc(r.author)}</div><div>${esc(r.content)}</div></div>`).join("")}
    </div>`;
}

// ---------- 处理过程 ----------

function renderProcess() {
  const v = state.view;
  if (!shown(state.cid, "brief", v)) { $("#tab-body").innerHTML = `<div class="card muted">生成简报后，这里会展示 AI 的处理过程：抽取了哪些事件、引用校验删掉了什么。</div>`; return; }
  const ev = v.events;
  const b = v.brief;
  const tok = (c) => (c?.usage ? c.usage.input_tokens + c.usage.output_tokens : 0);
  const val = b?.validation || {};
  $("#tab-body").innerHTML = `
    <div class="card"><h3>这次生成做了什么</h3>
      <div class="stat-row">
        <div class="stat"><b>${v.customer.records.length}</b><span>条原始沟通记录</span></div>
        <div class="stat"><b>${ev ? ev.data.length : "—"}</b><span>个抽取出的事件${ev ? `（${esc(ev.usage?.model || "")}）` : ""}</span></div>
        <div class="stat"><b>${val.removed ?? "—"}</b><span>条结论因没有出处被删除</span></div>
        <div class="stat"><b>${val.unverified_quotes ?? "—"}</b><span>处摘录未逐字匹配原文</span></div>
        <div class="stat"><b>${(tok(ev) + tok(b)).toLocaleString()}</b><span>tokens（抽取 + 简报）</span></div>
      </div>
      ${val.removed_items?.length ? `<div class="removed-list">被删除的内容：${val.removed_items.map(esc).join("；")}</div>` : ""}
    </div>
    ${ev ? `<div class="card"><h3>离线抽取的事件 <span class="muted">每条都绑定了原文</span></h3>
      <table class="ledger"><thead><tr><th>日期</th><th>类型</th><th>内容</th><th>截止</th><th>出处</th></tr></thead><tbody>
      ${ev.data.map((e) => `<tr><td>${esc(e.date)}</td><td><span class="pill">${esc(e.type)}</span></td><td>${esc(e.content)}</td><td>${esc(e.due_date || "")}</td><td>${cites([{ id: e.source_id, quote: e.quote, verified: e.verified }])}</td></tr>`).join("")}
      </tbody></table></div>` : ""}`;
}

// ---------- 今日推送（界面示意） ----------

$("#push-btn").onclick = async () => {
  const p = await api("/data/push.json");
  $("#push-body").innerHTML = p.cards.length
    ? `<div class="muted" style="font-size:12px;margin-bottom:8px">${esc(p.today)} 早上 8:30 · 发给 ${esc(p.user)}</div>` +
      p.cards.map((c) => `<div class="push-card"><div class="pc-title">${esc(c.short)}</div>
        ${c.overdue.length ? `<div class="pill red">逾期承诺</div><ul>${c.overdue.map((o) => `<li>${esc(o.content)}（截止 ${esc(o.due_date || "未写明")}）</li>`).join("")}</ul>` : ""}
        ${c.actions.length ? `<div class="pill blue">今天建议做</div><ul>${c.actions.map((a) => `<li>${esc(a.action)}</li>`).join("")}</ul>` : ""}
        <button class="btn small" data-open="${c.id}">打开客户简报</button></div>`).join("")
    : `<div class="push-card muted">先生成客户简报，这里会出现今天该跟进的客户。</div>`;
  $("#push-panel").classList.remove("hidden");
  document.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => { $("#push-panel").classList.add("hidden"); selectCustomer(b.dataset.open); }));
};
$("#push-close").onclick = () => $("#push-panel").classList.add("hidden");

// ---------- 设置 ----------

function openSettings() {
  $("#ping-status").className = "key-status";
  $("#ping-status").textContent = `抽取模型 ${state.list.models.extract} · 生成模型 ${state.list.models.generate}`;
  $("#settings").classList.remove("hidden");
}

$("#settings-btn").onclick = openSettings;
$("#settings-close").onclick = () => $("#settings").classList.add("hidden");
$("#settings").onclick = (e) => { if (e.target.id === "settings") $("#settings").classList.add("hidden"); };
$("#ping-btn").onclick = async () => {
  const el = $("#ping-status");
  $("#ping-btn").disabled = true;
  el.className = "key-status";
  el.textContent = "正在测试连接…";
  try {
    await api("/api/ping");
    el.className = "key-status ok";
    el.textContent = "✓ 已连接 DeepSeek，接口正常";
  } catch (e) {
    el.className = "key-status err";
    el.textContent = `✗ ${e.message}`;
  }
  $("#ping-btn").disabled = false;
};

$("#demo-reset").onclick = () => {
  state.revealed.clear();
  state.qa = {};
  state.adopted = {};
  state.ignored = {};
  state.resolved = {};
  $("#settings").classList.add("hidden");
  $("#drawer").classList.add("hidden");
  selectCustomer(state.list.customers[0].id);
  toast("已重置，可以重新开始演示");
};

// ---------- 启动 ----------

(async function init() {
  await refreshList();
  $("#today").textContent = `今天 ${state.list.today}`;
  $("#user").textContent = state.list.current_user;
  await selectCustomer(state.list.customers[0].id);
})();
