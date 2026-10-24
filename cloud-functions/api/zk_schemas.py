"""大模型输出的结构定义。每条结论都必须带出处（sources），便于引用校验和回溯原文。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Layer = Literal["事实", "客户诉求", "AI推断"]


class Source(BaseModel):
    id: str  # 记录/联系人/商机/客户资料的 ID，如 R112、P12、O12、A1
    quote: str  # 原文中逐字摘录的片段，用于高亮


class Statement(BaseModel):
    text: str
    layer: Layer
    sources: list[Source]


# ---------- 离线：事件抽取（小模型） ----------

class Event(BaseModel):
    type: Literal["需求", "顾虑", "我方承诺", "客户承诺", "人员变动", "阶段变化", "问题投诉", "关键事实"]
    date: str
    content: str
    people: list[str]
    due_date: str  # 承诺类事件的截止日期，YYYY-MM-DD；没有则为空字符串
    source_id: str
    quote: str


class Events(BaseModel):
    events: list[Event]


# ---------- 在线：客户简报（强模型） ----------

class Person(BaseModel):
    name: str
    title: str
    role: str
    status: Literal["在职", "已离职", "待确认"]
    attitude: str
    last_contact: str
    sources: list[Source]


class TimelineItem(BaseModel):
    date: str
    text: str
    sources: list[Source]


class Commitment(BaseModel):
    side: Literal["我方", "客户"]
    content: str
    owner: str
    promised_on: str
    due_date: str
    status: Literal["未开始", "进行中", "已兑现", "已逾期", "待确认"]
    status_reason: str
    sources: list[Source]


class Conflict(BaseModel):
    kind: Literal["信息冲突", "信息过期", "信息缺失", "状态与行为不符"]
    title: str
    detail: str
    suggestion: str
    sources: list[Source]


class Action(BaseModel):
    priority: Literal["高", "中", "低"]
    action: str
    reason: str
    sources: list[Source]


class Brief(BaseModel):
    who: list[Statement]
    people: list[Person]
    timeline: list[TimelineItem]
    status: list[Statement]
    commitments: list[Commitment]
    conflicts: list[Conflict]
    next_actions: list[Action]


# ---------- 交接模式 ----------

class Question(BaseModel):
    question: str
    why: str
    sources: list[Source]


class Handover(BaseModel):
    summary: list[Statement]
    risks: list[Statement]
    relationships: list[Statement]
    first_week: list[Action]
    questions_for_predecessor: list[Question]


# ---------- 带引用的问答 ----------

class Answer(BaseModel):
    found: bool
    statements: list[Statement]
    missing_note: str
