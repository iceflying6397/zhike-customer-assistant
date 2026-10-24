"""把 data/crm.json 和 cache/ 里已生成的结果，导出成网站用的静态数据。不调用大模型。

输出：
- public/data/customers.json、push.json、C1.json…（网页直接读取）
- cloud-functions/api/zk_data.py（实时问答云函数要用的客户资料和事件）

用法：.venv/bin/python scripts/build_static.py
"""
import json

from _paths import API_DIR, CACHE_DIR, DATA_FILE, PUBLIC_DATA

import zk_core
import zk_llm


def read_cache(cid, kind):
    p = CACHE_DIR / f"{cid}_{kind}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def write(name, obj):
    (PUBLIC_DATA / name).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def main():
    crm = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    items, cards, events_by_cid = [], [], {}
    for c in crm["customers"]:
        cid = c["id"]
        brief, handover, events = read_cache(cid, "brief"), read_cache(cid, "handover"), read_cache(cid, "events")
        qa = (read_cache(cid, "qa") or {"data": {}})["data"]
        qa = {q: qa[q] for q in c.get("demo_questions", []) if q in qa}
        signals = zk_core.rule_signals(crm, c)
        write(f"{cid}.json", {
            "today": crm["today"], "customer": c, "sources": zk_core.sources_of(c), "signals": signals,
            "events": events, "brief": brief, "handover": handover, "qa": qa,
        })
        items.append({
            "id": cid, "name": c["name"], "short": c["short"], "industry": c["account"]["industry"],
            "owner": c["account"]["owner"], "new_owner": c["account"].get("new_owner", ""),
            "record_count": len(c["records"]), "signals": signals, "has_brief": bool(brief),
            "conflict_count": len(brief["data"]["conflicts"]) if brief else None,
        })
        if brief:
            acts = [a for a in brief["data"]["next_actions"] if a["priority"] == "高"]
            overdue = [x for x in brief["data"]["commitments"] if x["status"] == "已逾期"]
            if acts or overdue:
                cards.append({"id": cid, "short": c["short"], "actions": acts[:2], "overdue": overdue[:2]})
        if events:
            events_by_cid[cid] = events["data"]
        missing = [k for k, v in [("客户简报", brief), ("事件", events)] if not v]
        missing += [f"问答「{q}」" for q in c.get("demo_questions", []) if q not in qa]
        if missing:
            print(f"注意：{c['short']} 缺少 {'、'.join(missing)}，先运行 scripts/pregenerate.py")
    write("customers.json", {"today": crm["today"], "current_user": crm["current_user"], "customers": items,
                             "models": {"extract": zk_llm.EXTRACT_MODEL, "generate": zk_llm.GENERATE_MODEL}})
    write("push.json", {"today": crm["today"], "user": crm["current_user"], "cards": cards})
    (API_DIR / "zk_data.py").write_text(
        '"""由 scripts/build_static.py 生成，请勿手改：实时问答用的客户资料和离线抽取的事件。"""\n'
        f"CRM = {json.dumps(crm, ensure_ascii=False)!r}\n"
        f"EVENTS = {json.dumps(events_by_cid, ensure_ascii=False)!r}\n"
        "import json as _json\nCRM = _json.loads(CRM)\nEVENTS = _json.loads(EVENTS)\n",
        encoding="utf-8",
    )
    print(f"已导出 {len(items)} 个客户到 public/data/，并更新 cloud-functions/api/zk_data.py")


if __name__ == "__main__":
    main()
