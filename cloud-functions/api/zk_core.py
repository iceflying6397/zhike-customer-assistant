"""核心逻辑：可引用来源、规则检测、拼材料、引用校验，以及线上两个接口（测试连接、实时问答）。

线上（EdgeOne 云函数）和本地脚本（scripts/）共用这一份代码。
"""
from __future__ import annotations

import re
from datetime import date, datetime

import openai

import zk_llm


def get_customer(crm: dict, cid: str) -> dict:
    for c in crm["customers"]:
        if c["id"] == cid:
            return c
    raise KeyError(cid)


def _d(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


# ---------- 可引用的来源 ----------

def sources_of(c: dict) -> dict[str, dict]:
    """客户名下所有可被引用的条目：ID -> {label, text}。text 是 quote 校验和高亮的依据。"""
    a = c["account"]
    out = {
        a["id"]: {
            "kind": "客户资料",
            "label": f"{a['id']} 客户资料",
            "text": f"{c['name']}｜行业：{a['industry']}｜规模：{a['size']}｜负责人：{a['owner']}｜合作始于：{a['since']}｜累计合同：{a['total_contract']}｜资料更新于：{a['updated_at']}",
        }
    }
    for p in c["contacts"]:
        out[p["id"]] = {
            "kind": "联系人",
            "label": f"{p['id']} 联系人·{p['name']}",
            "text": f"{p['name']}｜{p['title']}｜{p['role']}｜电话：{p['phone']}｜资料更新于：{p['updated_at']}",
        }
    for o in c["opportunities"]:
        out[o["id"]] = {
            "kind": "商机",
            "label": f"{o['id']} 商机·{o['name']}",
            "text": f"{o['name']}｜金额：{o['amount']}｜阶段：{o['stage']}｜更新于：{o['updated_at']}",
        }
    for r in c["records"]:
        out[r["id"]] = {
            "kind": "沟通记录",
            "label": f"{r['id']} {r['date']} {r['type']}·{r['author']}",
            "date": r["date"],
            "text": r["content"],
        }
    return out


# ---------- 规则检测（确定性，不依赖大模型） ----------

def rule_signals(crm: dict, c: dict) -> list[dict]:
    today = _d(crm["today"])
    signals = []
    last = max(_d(r["date"]) for r in c["records"])
    gap = (today - last).days
    if gap > 60:
        signals.append({"level": "warn", "text": f"已 {gap} 天没有任何沟通记录（最近一次 {last}）", "ids": [c["records"][-1]["id"]]})
    for p in c["contacts"]:
        age = (today - _d(p["updated_at"])).days
        if age > 365:
            signals.append({"level": "stale", "text": f"联系人 {p['name']}（{p['title']}）的资料 {age} 天未更新", "ids": [p["id"]]})
    for o in c["opportunities"]:
        if ("高意向" in o["stage"] or "谈判" in o["stage"]) and (today - _d(o["updated_at"])).days > 90:
            signals.append({"level": "warn", "text": f"商机「{o['name']}」标为「{o['stage']}」，但 {(today - _d(o['updated_at'])).days} 天未更新", "ids": [o["id"]]})
    if c["account"].get("new_owner"):
        signals.append({"level": "info", "text": f"待交接：{c['account']['owner']} → {c['account']['new_owner']}", "ids": [c["account"]["id"]]})
    return signals


# ---------- 拼给大模型的材料 ----------

def material(crm: dict, c: dict, events: list | None = None) -> str:
    a = c["account"]
    lines = [f"# 今天：{crm['today']}（当前使用者：{crm['current_user']}）", "", f"# 客户资料", f"[{a['id']}] {sources_of(c)[a['id']]['text']}", "", "# 联系人（来自系统字段，可能过期）"]
    for p in c["contacts"]:
        lines.append(f"[{p['id']}] {p['name']}｜{p['title']}｜{p['role']}｜电话：{p['phone']}｜资料更新于：{p['updated_at']}")
    lines += ["", "# 商机"]
    for o in c["opportunities"]:
        lines.append(f"[{o['id']}] {o['name']}｜金额：{o['amount']}｜阶段：{o['stage']}｜更新于：{o['updated_at']}")
    lines += ["", "# 沟通记录（按时间正序，作者记录习惯各不相同）"]
    for r in sorted(c["records"], key=lambda r: r["date"]):
        lines.append(f"[{r['id']}] {r['date']}｜{r['type']}｜{r['author']}：{r['content']}")
    lines += ["", "# 公司人员", *[f"- {s['name']}：{s['role']}{'；' + s['note'] if s.get('note') else ''}" for s in crm["staff"]]]
    if events:
        lines += ["", "# 离线抽取的事件（供参考，以原文为准）"]
        for e in events:
            due = f"｜截止：{e['due_date']}" if e.get("due_date") else ""
            lines.append(f"- [{e['source_id']}] {e['date']}｜{e['type']}｜{e['content']}{due}")
    sig = rule_signals(crm, c)
    if sig:
        lines += ["", "# 规则检测信号（供参考）", *[f"- {s['text']}（{', '.join(s['ids'])}）" for s in sig]]
    return "\n".join(lines)


# ---------- 引用校验 ----------

_PUNCT = re.compile(r"[\s，。、；：！？,.;:!?（）()「」“”\"'…—\-]")


def _norm(s: str) -> str:
    return _PUNCT.sub("", s)


def _check_sources(srcs: list[dict], valid: dict[str, dict], stats: dict) -> list[dict]:
    kept = []
    for s in srcs:
        sid = s.get("id", "").strip().strip("[]")
        if sid not in valid:
            stats["bad_ids"] += 1
            continue
        q = s.get("quote", "")
        ok = bool(q) and _norm(q) in _norm(valid[sid]["text"])
        if not ok:
            stats["unverified_quotes"] += 1
        kept.append({"id": sid, "quote": q if ok else "", "verified": ok})
    return kept


def validate(obj, valid: dict[str, dict], stats: dict):
    """递归检查每个带 sources 的条目：无效 ID 丢掉；一个有效出处都没有的条目整条删掉。"""
    if isinstance(obj, list):
        out = []
        for x in obj:
            v = validate(x, valid, stats)
            if v is not None:
                out.append(v)
        return out
    if isinstance(obj, dict):
        if "sources" in obj:
            obj["sources"] = _check_sources(obj["sources"], valid, stats)
            if not obj["sources"]:
                stats["removed"] += 1
                stats["removed_items"].append(obj.get("text") or obj.get("content") or obj.get("action") or obj.get("title") or obj.get("question") or obj.get("name") or "")
                return None
        return {k: (validate(v, valid, stats) if k != "sources" else v) for k, v in obj.items()}
    return obj


def _new_stats() -> dict:
    return {"removed": 0, "bad_ids": 0, "unverified_quotes": 0, "removed_items": []}


# ---------- 线上接口：返回 (状态码, JSON) ----------

def _api_error(e: Exception) -> tuple[int, dict]:
    if isinstance(e, openai.AuthenticationError):
        return 401, {"error": "API Key 无效，请联系演示提供者"}
    if isinstance(e, openai.RateLimitError):
        return 429, {"error": "请求太频繁，请稍后再试"}
    if isinstance(e, openai.APIStatusError):
        if e.status_code == 402:
            return 402, {"error": "API 额度已用完，需要充值"}
        return 502, {"error": f"大模型接口报错（{e.status_code}）"}
    if isinstance(e, openai.APIConnectionError):
        return 502, {"error": "连不上 DeepSeek 接口，请稍后再试"}
    return 500, {"error": str(e)[:200] or "服务出错了"}


def ping() -> tuple[int, dict]:
    """测试连接：用小模型回一个词。"""
    if not zk_llm.has_credentials():
        return 503, {"error": "服务端还没有配置 API Key"}
    try:
        zk_llm.ping()
    except Exception as e:  # noqa: BLE001
        return _api_error(e)
    return 200, {"ok": True, "models": {"extract": zk_llm.EXTRACT_MODEL, "generate": zk_llm.GENERATE_MODEL}}


def ask(body: dict) -> tuple[int, dict]:
    """实时问答：用户自己输入的新问题。线上不能写文件，回答不保存。"""
    import zk_data

    cid = (body.get("cid") or "").strip()
    question = (body.get("question") or "").strip()[:200]
    if not question:
        return 400, {"error": "问题不能为空"}
    try:
        c = get_customer(zk_data.CRM, cid)
    except KeyError:
        return 404, {"error": "客户不存在"}
    if not zk_llm.has_credentials():
        return 503, {"error": "服务端还没有配置 API Key"}
    try:
        parsed, usage = zk_llm.answer(material(zk_data.CRM, c, zk_data.EVENTS.get(cid)), question)
    except Exception as e:  # noqa: BLE001
        return _api_error(e)
    stats = _new_stats()
    data = validate(parsed.model_dump(), sources_of(c), stats)
    return 200, {"data": data, "usage": usage, "validation": stats, "question": question}
