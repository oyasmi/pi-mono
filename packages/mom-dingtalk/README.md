# mom-dingtalk

钉钉 AI Card 机器人 — 将 [pi-coding-agent](../coding-agent) 接入钉钉，提供流式 AI 卡片交互、身份/记忆系统、技能扩展和定时事件。

## 功能

- **钉钉 Stream 模式** — 通过 `dingtalk-stream` SDK（DWClient）接收消息，自动重连
- **AI Card 流式输出** — 过程性思考/执行信息通过 AI 卡片流式展示，最终答案通过普通 Markdown 消息快速返回
- **内置 Slash 命令** — 钉钉渠道直接支持 `/help`、`/new`、`/compact`、`/session`、`/model`
- **多租户隔离** — 每个用户 DM / 群聊独立工作空间（`dm_{staffId}` / `group_{conversationId}`）
- **配置文件驱动** — Agent 行为通过 `SOUL.md`、`AGENT.md`、`MEMORY.md` 配置
- **技能系统** — 支持全局和频道级 Skill 扩展
- **定时事件** — 支持 immediate / one-shot / periodic 定时任务，并持久化会话元数据以支持重启后的主动发送
- **沙箱执行** — 支持 Host 直接执行和 Docker 容器隔离
- **多模型支持** — 通过 `models.json` 配置自定义 LLM 提供商和模型

## 快速开始

### 1. 配置钉钉应用

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建企业内部应用：

1. 创建应用 → 获取 Client ID 和 Client Secret
2. 开启机器人能力 → Stream 模式
3. 创建 AI 卡片模板 → 获取 Card Template ID

### 2. 创建配置文件

```bash
mkdir -p ~/.pi/mom-dingtalk

cat > ~/.pi/mom-dingtalk/config.json << 'EOF'
{
  "clientId": "your-app-key",
  "clientSecret": "your-app-secret",
  "robotCode": "your-robot-code",
  "cardTemplateId": "your-card-template-id",
  "cardTemplateKey": "content",
  "allowFrom": ["your-staff-id"]
}
EOF
```

### 3. 设置 API 密钥

```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

或创建 `~/.pi/mom-dingtalk/auth.json`：

```json
{
  "anthropic": "your-anthropic-api-key"
}
```

### 4. 运行

```bash
# Host 模式（默认）
mom-dingtalk

# Docker 模式
mom-dingtalk --sandbox=docker:my-container
```

工作目录固定为 `~/.pi/mom-dingtalk/workspace/`，首次运行时自动创建默认配置文件。

## 消息交互模型

- **过程消息** — Tool 调用、重试、压缩上下文、思考说明等过程性信息写入 AI Card
- **最终答案** — 最终答复单独以 Markdown 消息发送，避免等待 AI Card 流式收尾
- **无过程输出时** — 不会创建 AI Card，直接发送最终消息

## 内置 Slash 命令

以下命令由 `mom-dingtalk` 渠道直接处理，不会作为普通 prompt 发送给模型：

- `/help` — 返回钉钉渠道支持的命令说明和示例
- `/new` — 开启一个新会话
- `/compact [instructions]` — 手动压缩当前会话上下文
- `/session` — 查看当前会话状态、消息统计、token 和成本
- `/model [provider/modelId|modelId]` — 查看当前模型，或按精确匹配切换模型

说明：

- `/model` 无参数时返回当前模型和可用模型列表
- `/model <ref>` 只支持精确匹配；建议优先使用 `provider/modelId`
- 其他 slash 输入不会被 `mom-dingtalk` 拦截，仍会走 `AgentSession.prompt()` 的原有逻辑，例如 extension command、prompt template、`/skill:...`

## 配置文件

### config.json

| 字段 | 必填 | 说明 |
|------|------|------|
| `clientId` | ✅ | 钉钉应用的 App Key |
| `clientSecret` | ✅ | 钉钉应用的 App Secret |
| `robotCode` | 可选 | 机器人编码（默认使用 clientId）|
| `cardTemplateId` | 推荐 | AI 卡片模板 ID（不设置则降级为普通消息）|
| `cardTemplateKey` | 可选 | 卡片模板变量名（默认 `content`）|
| `allowFrom` | 可选 | 允许使用的用户 staffId 列表，空或不配置则允许所有人 |

### auth.json

API 密钥配置，格式为 `{ "provider": "key" }`。也可通过环境变量设置（如 `ANTHROPIC_API_KEY`）。

### models.json

自定义模型配置，格式与 [pi-coding-agent](../coding-agent) 的 `~/.pi/agent/models.json` 相同。如不配置则使用默认模型（Claude Sonnet 4.5）。

### SOUL.md / AGENT.md / MEMORY.md

```
~/.pi/mom-dingtalk/workspace/
├── SOUL.md              # Agent 身份/性格（全局，只读）
├── AGENT.md             # Agent 行为指令（全局，只读）
├── MEMORY.md            # Agent 记忆（全局，可读写）
├── skills/              # 全局技能目录
├── events/              # 定时事件（JSON 文件）
└── dm_{userId}/         # 用户工作空间（群聊为 group_{conversationId}）
    ├── AGENT.md         # 频道级行为指令（与全局层叠）
    ├── MEMORY.md        # 频道级记忆
    ├── .channel-meta.json # 会话寻址元数据（用于主动发送与重启恢复）
    ├── context.jsonl    # LLM 上下文（结构化消息）
    ├── log.jsonl        # 消息历史（人类可读）
    └── skills/          # 频道级技能
```

- **SOUL.md** — 定义 Agent 的身份、性格和沟通风格
- **AGENT.md** — 定义 Agent 的行为规则、约束和能力（支持全局 + 频道级层叠）
- **MEMORY.md** — Agent 的持久记忆，跨会话保留（Agent 可自行读写，超过 5000 字符时会提示整理）

### 定时事件

在 `events/` 目录中创建 JSON 文件来触发定时任务：

| 类型 | 说明 |
|------|------|
| `immediate` | 立即执行一次 |
| `one-shot` | 在指定时间执行一次 |
| `periodic` | 按 cron 表达式周期执行 |

示例 — 每周日凌晨 3 点整理记忆（`events/memory-review.json`）：

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "Review your MEMORY.md files. Remove outdated entries, merge duplicates, ensure well-organized.",
  "schedule": "0 3 * * 0",
  "timezone": "Asia/Shanghai"
}
```

说明：

- 定时事件会向 `channelId` 指定的既有会话发送消息
- 首次收到真实钉钉消息后，会保存该会话的寻址元数据；之后即使 bot 重启，事件仍可继续向该会话主动发送消息

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥（也可通过 auth.json 配置）|
| `MOM_DEBUG` | 设为任意值启用调试模式，将完整上下文写入 `last_prompt.json` |
| `DINGTALK_FORCE_PROXY` | 设为 `true` 保留 axios 代理设置（默认禁用代理）|

## 架构

```
dingtalk-stream (DWClient)
       │
  DingTalkBot ←── DingTalk API (Card + Token)
       │
  Handler ←── EventsWatcher
       │
  AgentRunner ←── Agent + Session + Tools
       │
  Executor ←── Host / Docker
```

## 开发

```bash
# 从 monorepo 根目录安装依赖
npm install

# 构建
npm run build

# 开发监视模式
npm run dev
```
