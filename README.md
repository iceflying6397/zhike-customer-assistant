# 知客 · 企业客户信息助手 Demo

把散落在 CRM 里的客户记录整理成一份**每句话都能回溯原文**的客户简报，标出矛盾和过期的信息，并给出下一步建议。

演示故事：**销售王悦今天接手了离职同事陈磊的客户，明天要去拜访恒川精密。**

## 功能

- **客户简报**：下一步建议、需要确认的问题（信息冲突 / 过期 / 缺失 / 状态与行为不符）、客户是谁、当前状态、关键人、合作时间线
- **承诺台账**：从沟通记录里抽出我方和客户的承诺，判断是否兑现、是否逾期
- **交接模式**：交接简报、风险与坑、关系地图、第一周该做的事、「问前任」清单
- **带引用的问答**：每句回答都有出处，记录里没有就直接说没有
- **原文回溯**：点任何一个角标（R112、P12…），右侧显示原文并高亮引用的那句话
- **处理过程**：离线抽取了哪些事件、引用校验删掉了什么

## 架构

```
public/                静态网站（EdgeOne Pages 的输出目录）
  index.html, app.js, style.css
  data/                客户资料和已生成的结果（由 scripts/build_static.py 导出）
cloud-functions/api/   Python 云函数
  ping.py              GET  /api/ping  测试能否连上 DeepSeek
  ask.py               POST /api/ask   实时问答
  zk_core.py           可引用来源、规则检测、拼材料、引用校验
  zk_llm.py            提示词和大模型调用
  zk_schemas.py        大模型输出结构（每条结论都带 sources）
  zk_data.py           客户资料和离线抽取的事件（自动生成）
data/crm.json          模拟的老 CRM 数据（4 个客户、28 条沟通记录）
cache/                 用真实 API 生成的结果（事件、简报、交接简报、预设问答）
scripts/               本地脚本：重新生成数据、导出静态数据、本地预览
edgeone.json           EdgeOne 配置（静态目录、云函数超时 120 秒）
```

- **离线抽取、在线生成**：小模型（deepseek-flash）把每条记录拆成带原文出处的事件；强模型（deepseek-v4-pro）基于事件写简报、找冲突、给建议。
- **引用校验**：模型每句话都要给出来源 ID 和原文逐字摘录。程序检查：来源不属于这个客户就丢掉；一个有效来源都没有的句子整句删除；摘录在原文里对不上就不高亮，角标显示为虚线。
- 演示数据是固定的，客户简报、交接简报和预设问答已提前生成，页面打开即可演示；问答里输入新问题会实时调用 DeepSeek。

## 部署到 EdgeOne Pages

1. 把这个目录作为仓库上传到 GitHub。
2. 在 EdgeOne Pages 新建项目，导入这个仓库。
   - 构建命令：留空（不需要构建）
   - 输出目录：`public`（`edgeone.json` 里已写好）
3. 在项目设置的**环境变量**里添加：
   - `DEEPSEEK_API_KEY` = 你的 DeepSeek API Key
4. 部署完成后打开链接，点右上角「设置」→「测试连接」，显示「已连接 DeepSeek」即可。
   - Key 只配置在 EdgeOne 的环境变量里，不在代码仓库中。
   - DeepSeek 额度用完时，页面会提示「API 额度已用完，需要充值」。

## 本地运行（可选）

```bash
python3 -m venv .venv
.venv/bin/pip install -r cloud-functions/requirements.txt
.venv/bin/python scripts/dev_server.py        # 打开 http://localhost:8765
```

想用新数据或新提示词重新生成全部结果（会调用 API）：

```bash
export DEEPSEEK_API_KEY=你的key
.venv/bin/python scripts/pregenerate.py --refresh
```

只改了 `data/crm.json` 或页面数据格式、不需要重新调用 API 时：

```bash
.venv/bin/python scripts/build_static.py
```

## 模型

通过 DeepSeek 的 OpenAI 兼容接口调用（`https://api.deepseek.com`）。DeepSeek 的 JSON 模式只保证输出是合法 JSON，不保证字段齐全，所以程序会用结构定义校验返回结果，不合格就把错误告诉模型重试一次。

| 环节 | 模型 | 思考模式 | 可用环境变量替换 |
| --- | --- | --- | --- |
| 离线事件抽取 | deepseek-flash | 关闭 | `EXTRACT_MODEL` |
| 简报、交接、问答 | deepseek-v4-pro | 开启 | `GENERATE_MODEL`、`GENERATE_THINKING` |

## 模拟数据

数据在 `data/crm.json`，今天固定为 2026-10-26，当前用户是王悦。

- **恒川精密**（主线）：离职的 CTO 仍是联系人表里的关键决策人；他离职后仍有人约「王总」看演示；答应的二期报价已逾期，而客户 10 月底就要定预算；商机金额 150 万与客户口头预算 120 万以内不一致；12 台老设备没有网口；前任的交接备注写「问题不大」。
- **云帆物流**：75 天没联系、合同年底到期、竞品报价低三成、多扣费投诉没有闭环。
- **启明医疗**：新线索，记录很少。
- **博远教育**：健康客户，作为对照。
