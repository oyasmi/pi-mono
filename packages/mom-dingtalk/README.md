# mom-dingtalk

DingTalk（钉钉）AI Card 机器人，基于 [mom](../mom) 架构适配。

## 功能

- **钉钉 Stream 模式** — 通过 `dingtalk-stream` SDK（DWClient）接收消息
- **AI Card 流式输出** — 实时流式更新 AI 卡片内容，非最终结果一次性发送
- **多租户隔离** — 每个用户 DM / 群聊独立工作空间（`dm_{staffId}` / `group_{conversationId}`）
- **配置文件驱动** — Agent 行为通过 `SOUL.md`、`AGENT.md`、`MEMORY.md` 配置
- **技能系统** — 支持全局和频道级 Skill 扩展
- **定时事件** — 支持 immediate / one-shot / periodic 定时任务
- **沙箱执行** — 支持 Host 直接执行和 Docker 容器隔离

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
# Host 模式
mom-dingtalk ./workspace

# Docker 模式
mom-dingtalk --sandbox=docker:my-container ./workspace
```

## 配置文件

### config.json

| 字段 | 必填 | 说明 |
|------|------|------|
| `clientId` | ✅ | 钉钉应用的 App Key |
| `clientSecret` | ✅ | 钉钉应用的 App Secret |
| `robotCode` | 可选 | 机器人编码（默认使用 clientId）|
| `cardTemplateId` | 推荐 | AI 卡片模板 ID（不设置则不使用 AI Card）|
| `cardTemplateKey` | 可选 | 卡片模板变量名（默认 `content`）|
| `allowFrom` | 可选 | 允许使用的用户ID（staffId）列表。如果不配置或为空列表，则允许所有人使用 |

### SOUL.md / AGENT.md / MEMORY.md

```
workspace/
├── SOUL.md          # Agent 身份/性格（全局，只读）
├── AGENT.md         # Agent 行为指令（全局，只读）
├── MEMORY.md        # Agent 记忆（全局，可读写）
├── skills/          # 全局技能目录
├── events/          # 定时事件
└── dm_{userId}/     # 用户工作空间
    ├── AGENT.md     # 频道级行为指令（可覆盖全局）
    ├── MEMORY.md    # 频道级记忆
    ├── log.jsonl    # 消息历史
    └── skills/      # 频道级技能
```

- **SOUL.md** — 定义 Agent 的身份、性格和沟通风格
- **AGENT.md** — 定义 Agent 的行为规则、约束和能力（支持全局 + 频道级层叠）
- **MEMORY.md** — Agent 的持久记忆，跨会话保留

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
# 安装依赖
npm install

# 构建
npm run build

# 开发监视模式
npm run dev
```
