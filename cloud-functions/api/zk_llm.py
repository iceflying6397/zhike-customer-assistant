"""大模型调用：离线抽取用小模型，在线生成用强模型（对应产品文档 8.1 / 8.2）。

使用 DeepSeek（OpenAI 兼容接口）。DeepSeek 的 JSON 模式只保证输出是合法 JSON，
不保证符合结构，所以这里把结构写进提示词，返回后用 pydantic 校验，不合格就带着错误重试一次。
"""
from __future__ import annotations

import json
import os

import openai
from pydantic import ValidationError

from zk_schemas import Answer, Brief, Events, Handover

BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "deepseek-flash")
GENERATE_MODEL = os.environ.get("GENERATE_MODEL", "deepseek-v4-pro")
# 生成环节默认开启思考模式（质量更好、更慢）；设为 disabled 可以提速
GENERATE_THINKING = os.environ.get("GENERATE_THINKING", "enabled")

_client = None


def client() -> openai.OpenAI:
    """Key 只从环境变量读取（EdgeOne 项目设置里配置 DEEPSEEK_API_KEY），不写进任何文件。"""
    global _client
    if _client is None:
        # 云函数最长 120 秒，这里留出余量，且不自动重试
        _client = openai.OpenAI(api_key=os.environ.get("DEEPSEEK_API_KEY"), base_url=BASE_URL, timeout=100, max_retries=0)
    return _client


def has_credentials() -> bool:
    return bool(os.environ.get("DEEPSEEK_API_KEY"))


def ping():
    client().chat.completions.create(
        model=EXTRACT_MODEL,
        messages=[{"role": "user", "content": "回复 OK"}],
        max_tokens=10,
        extra_body={"thinking": {"type": "disabled"}},
    )


def _json_instruction(schema) -> str:
    return (
        "\n\n# 输出格式\n只输出一个 json 对象，不要输出任何其他文字。JSON 必须符合下面的 JSON Schema，"
        "所有字段都必须出现，没有内容的列表用 []，没有内容的字符串用 \"\"：\n"
        + json.dumps(schema.model_json_schema(), ensure_ascii=False)
    )


def _parse(model: str, system: str, user: str, schema, thinking: str):
    messages = [
        {"role": "system", "content": system + _json_instruction(schema)},
        {"role": "user", "content": user},
    ]
    usage = {"model": model, "input_tokens": 0, "output_tokens": 0}
    last_error = ""
    for _ in range(2):
        resp = client().chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
            max_tokens=32000,
            stream=False,
            extra_body={"thinking": {"type": thinking}},
        )
        if resp.usage:
            usage["input_tokens"] += resp.usage.prompt_tokens
            usage["output_tokens"] += resp.usage.completion_tokens
        choice = resp.choices[0]
        content = choice.message.content or ""
        if choice.finish_reason == "length":
            last_error = "输出超长被截断"
        elif not content.strip():
            last_error = "模型返回了空内容"
        else:
            try:
                return schema.model_validate_json(content), usage
            except ValidationError as e:
                last_error = f"输出不符合结构：{e.errors()[:3]}"
                messages += [
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": f"你的输出不符合要求的 JSON 结构，错误：{e}\n请修正后重新输出完整的 JSON。"},
                ]
    raise RuntimeError(f"生成失败（已重试）：{last_error}")


CITE_RULES = """引用规则（必须遵守）：
- 只能使用材料里出现的信息，不得补充常识或猜测。
- 每条结论的 sources 至少一条；id 必须是材料中的 ID（R 开头为沟通记录，P 为联系人，O 为商机，A 为客户资料）。
- quote 必须从该 ID 的原文中逐字复制一段（5–40 字），不要改写、不要加省略号。
- layer 的含义：「事实」= 系统字段或记录中明确发生的事；「客户诉求」= 客户说过的话、提出的要求或顾虑；「AI推断」= 你基于多条材料的判断，必须在 text 里写出推断理由。"""


EXTRACT_SYSTEM = """你是企业客户系统的数据整理员。任务：把一个客户的全部沟通记录逐条拆成结构化事件。
- 一条记录可以拆出 0 到多条事件；只拆有业务意义的内容（需求、顾虑、承诺、人员变动、阶段变化、问题投诉、关键事实）。
- 我方承诺 / 客户承诺：写清楚谁答应了什么；能从上下文推出截止日期就填 due_date（YYYY-MM-DD），例如「两周内」按记录日期往后推 14 天；推不出就留空。
- source_id 填记录 ID，quote 从该记录原文逐字复制一段。
- 不要合并不同记录的事件，不要评价，只做抽取。"""


BRIEF_SYSTEM = f"""你是 B2B 销售团队的客户信息助手。业务人员打开一个客户时，你要基于系统里的材料生成一份客户简报，回答三个问题：这个客户是谁、过去发生过什么、现在最该做什么。

{CITE_RULES}

各部分要求：
- who：3–5 条，客户基本情况、合作历史、当前合作金额。
- people：每个联系人一条。status 要结合沟通记录判断（例如记录说已离职，就标「已离职」，即使联系人表没更新）。attitude 写对我方的态度或关注点，没有依据写「记录中未体现」。last_contact 写最近一次在记录中出现的日期。
- timeline：只列关键节点（签约、上线、投诉、人员变动、关键拜访），按时间正序，5–8 条。
- status：当前在推进什么、卡在哪、有什么风险信号，2–4 条。
- commitments：列出所有我方和客户的承诺。根据「今天」的日期和后续记录判断状态：后续记录证明做了→已兑现；过了截止日且没有兑现记录→已逾期；没到截止日→进行中；无法判断→待确认，并在 status_reason 说明原因。
- conflicts：主动找出材料里的问题，这是最重要的部分，宁可多报不要漏报：
  · 信息冲突：不同来源说法矛盾（如联系人表写某人是关键决策人，但记录显示其已离职；或后来的记录仍把已离职的人当作联系人）
  · 信息过期：关键信息很久没更新
  · 信息缺失：按流程应该有但找不到的记录（如答应了报价却没有报价记录）
  · 状态与行为不符：如商机标为高意向但长期没有联系，或金额与客户口径不一致
  每条给出 suggestion（建议业务人员怎么确认或处理）。
- next_actions：1–3 条，按优先级排序。action 要具体到做什么、对谁、什么时候前；reason 写清楚为什么现在做（引用截止日、逾期天数、预算节点等）。

规则检测结果仅供参考，你需要结合原文核实后再采用。"""


HANDOVER_SYSTEM = f"""你是 B2B 销售团队的客户信息助手，现在要为「客户交接」生成交接简报，读者是接手的新负责人，他从没接触过这个客户。

{CITE_RULES}

各部分要求：
- summary：3–4 条，用最短的话讲清楚客户是谁、合作到哪一步、最近最重要的事。
- risks：接手后最容易踩的坑（客户投诉过什么、对什么敏感、哪些承诺快到期或已逾期、竞争情况），2–5 条。
- relationships：前任和哪些人关系好、哪些关系需要重新建立、谁拍板，2–4 条。
- first_week：新负责人第一周该做的 3 件事，按优先级。
- questions_for_predecessor：3–5 个问题，请前任在离职前回答。只问记录里缺失或矛盾、而前任很可能知道的事（例如：报价做到哪一步了、某个口头承诺的细节）。why 写为什么要问，sources 指向引发这个问题的材料。

前任写的交接备注可能过于乐观，需要对照记录核实。"""


ANSWER_SYSTEM = f"""你是 B2B 销售团队的客户信息助手，回答业务人员关于某个客户的提问。

{CITE_RULES}

- 只根据材料回答。材料中能找到依据：found=true，statements 逐句回答，每句带出处。
- 材料中找不到依据：found=false，statements 为空，missing_note 写明「记录中没有相关信息」，并建议可以向谁确认。不要猜。
- 部分能回答：能回答的部分写进 statements，缺的部分写进 missing_note。"""


def extract_events(material: str):
    return _parse(EXTRACT_MODEL, EXTRACT_SYSTEM, material, Events, "disabled")


def generate_brief(material: str):
    return _parse(GENERATE_MODEL, BRIEF_SYSTEM, material, Brief, GENERATE_THINKING)


def generate_handover(material: str):
    return _parse(GENERATE_MODEL, HANDOVER_SYSTEM, material, Handover, GENERATE_THINKING)


def answer(material: str, question: str):
    return _parse(GENERATE_MODEL, ANSWER_SYSTEM, f"{material}\n\n# 业务人员的问题\n{question}", Answer, GENERATE_THINKING)
