"""用真实 API 重新生成演示数据（事件、客户简报、交接简报、预设问答），存到 cache/，再导出静态数据。

用法：
  export DEEPSEEK_API_KEY=你的key
  .venv/bin/python scripts/pregenerate.py            # 只补缺的
  .venv/bin/python scripts/pregenerate.py --refresh  # 全部重新生成
"""
import json
import sys
from datetime import datetime

from _paths import CACHE_DIR, DATA_FILE

import build_static
import zk_core
import zk_llm


def read_cache(cid, kind):
    p = CACHE_DIR / f"{cid}_{kind}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def write_cache(cid, kind, payload):
    payload["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    CACHE_DIR.mkdir(exist_ok=True)
    (CACHE_DIR / f"{cid}_{kind}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def events(crm, c, refresh):
    cached = read_cache(c["id"], "events")
    if cached and not refresh:
        return cached
    parsed, usage = zk_llm.extract_events(zk_core.material(crm, c))
    valid = zk_core.sources_of(c)
    out, stats = [], zk_core._new_stats()
    for e in parsed.model_dump()["events"]:
        if e["source_id"] not in valid:
            stats["bad_ids"] += 1
            continue
        e["verified"] = bool(e["quote"]) and zk_core._norm(e["quote"]) in zk_core._norm(valid[e["source_id"]]["text"])
        if not e["verified"]:
            stats["unverified_quotes"] += 1
        out.append(e)
    return write_cache(c["id"], "events", {"data": out, "usage": usage, "validation": stats})


def generate(crm, c, kind, fn, ev):
    parsed, usage = fn(zk_core.material(crm, c, ev))
    stats = zk_core._new_stats()
    data = zk_core.validate(parsed.model_dump(), zk_core.sources_of(c), stats)
    return write_cache(c["id"], kind, {"data": data, "usage": usage, "validation": stats})


def main():
    if not zk_llm.has_credentials():
        sys.exit("请先 export DEEPSEEK_API_KEY=你的key")
    refresh = "--refresh" in sys.argv
    crm = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    for c in crm["customers"]:
        cid = c["id"]
        ev = events(crm, c, refresh)["data"]
        if refresh or not read_cache(cid, "brief"):
            print(f"{c['short']}：生成客户简报…", flush=True)
            generate(crm, c, "brief", zk_llm.generate_brief, ev)
        if c["account"].get("new_owner") and (refresh or not read_cache(cid, "handover")):
            print(f"{c['short']}：生成交接简报…", flush=True)
            generate(crm, c, "handover", zk_llm.generate_handover, ev)
        qa = read_cache(cid, "qa") or {"data": {}}
        for q in c.get("demo_questions", []):
            if refresh or q not in qa["data"]:
                print(f"{c['short']}：回答「{q}」…", flush=True)
                parsed, usage = zk_llm.answer(zk_core.material(crm, c, ev), q)
                stats = zk_core._new_stats()
                data = zk_core.validate(parsed.model_dump(), zk_core.sources_of(c), stats)
                qa["data"][q] = {"data": data, "usage": usage, "validation": stats, "question": q}
                write_cache(cid, "qa", qa)
    build_static.main()


if __name__ == "__main__":
    main()
