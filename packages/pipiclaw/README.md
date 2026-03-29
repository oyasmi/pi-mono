# pipiclaw

Pipiclaw 是一个接入钉钉的 AI Card 机器人，把 [pi-coding-agent](../coding-agent) 带到钉钉对话里，支持过程性 AI 卡片、最终 Markdown 回复、内置 Slash 命令、技能扩展和定时事件。

## 功能

- 钉钉 Stream 模式接收消息，自动重连
- 过程性思考和执行信息通过 AI Card 展示，最终答复独立快速返回
- 内置 Slash 命令：`/help`、`/new`、`/compact`、`/session`、`/model`
- 每个 DM / 群聊独立工作空间
- 支持全局和频道级 `SOUL.md`、`AGENT.md`、`MEMORY.md`
- 支持全局和频道级技能目录
- 支持 immediate / one-shot / periodic 定时事件
- 支持自定义模型配置和模型切换

## 安装

```bash
npm install -g @oyasmi/pipiclaw
```

## 首次运行

```bash
pipiclaw
```

首次运行时，Pipiclaw 会自动创建 `~/.pi/pipiclaw/`，并生成这些文件和目录：

- `channel.json`
- `auth.json`
- `models.json`
- `settings.json`
- `workspace/`
- `workspace/events/`
- `workspace/skills/`
- `workspace/SOUL.md`
- `workspace/AGENT.md`
- `workspace/MEMORY.md`

如果 `channel.json` 还是示例占位符，程序会提示你先填写真实配置，然后退出。

## 钉钉应用配置

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建企业内部应用：

1. 创建应用并获取 `Client ID` 和 `Client Secret`
2. 开启机器人能力并启用 Stream 模式
3. 如需 AI Card 流式输出，创建 AI 卡片模板并获取 `Card Template ID`

## 配置文件

### channel.json

`~/.pi/pipiclaw/channel.json`

程序会自动生成一个模板文件。你需要至少填写：

- `clientId`
- `clientSecret`

通常还会填写：

- `robotCode`
- `cardTemplateId`
- `allowFrom`

模板示例：

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "your-robot-code",
  "cardTemplateId": "your-card-template-id",
  "cardTemplateKey": "content",
  "allowFrom": ["your-staff-id"]
}
```

说明：

- `robotCode` 留空时默认回退到 `clientId`
- `cardTemplateId` 留空时不使用 AI Card 流式输出
- `allowFrom` 设为 `[]` 或删除时允许所有人

### auth.json

`~/.pi/pipiclaw/auth.json`

首次运行会自动生成空对象：

```json
{}
```

如果你使用环境变量提供模型密钥，可以一直保持为空。也可以手工写成：

```json
{
  "anthropic": "your-anthropic-api-key"
}
```

### models.json

`~/.pi/pipiclaw/models.json`

首次运行会自动生成最小合法空配置。你需要在 `providers` 下面自己添加自定义 provider 和模型定义：

```json
{
  "providers": {}
}
```

如果你不需要自定义模型，可以一直保持这个空配置。

### settings.json

`~/.pi/pipiclaw/settings.json`

首次运行会自动生成：

```json
{}
```

`/model` 等命令写入的默认模型会保存在这里，并在重启后继续生效。

## 运行

填写好 `channel.json` 和模型认证信息后，再次启动：

```bash
pipiclaw
```

如需 Docker sandbox，可以显式指定：

```bash
pipiclaw --sandbox=docker:your-container
```

## 内置 Slash 命令

以下命令由 Pipiclaw 直接处理，不会作为普通 prompt 发送给模型：

- `/help`
- `/new`
- `/compact [instructions]`
- `/session`
- `/model [provider/modelId|modelId]`

说明：

- `/model` 无参数时返回当前模型和可用模型列表
- `/model <ref>` 只支持精确匹配
- 未被 Pipiclaw 拦截的其他 slash 输入，仍会按 `AgentSession.prompt()` 的原有逻辑处理

### SOUL.md / AGENT.md / MEMORY.md

首次运行生成的 `SOUL.md` 和 `AGENT.md` 只是说明模板，不是实际配置。

- `SOUL.md` 用来定义身份、语气、默认语言和回复风格
- `AGENT.md` 用来定义行为规则、工具使用策略和安全约束
- `MEMORY.md` 用来记录长期记忆

你需要根据自己的实际使用场景，把 `SOUL.md` 和 `AGENT.md` 改成真正的内容。

## 工作空间布局

```text
~/.pi/pipiclaw/
├── channel.json
├── auth.json
├── models.json
├── settings.json
└── workspace/
    ├── SOUL.md
    ├── AGENT.md
    ├── MEMORY.md
    ├── skills/
    ├── events/
    └── dm_{userId}/
        ├── AGENT.md
        ├── MEMORY.md
        ├── .channel-meta.json
        ├── context.jsonl
        ├── log.jsonl
        └── skills/
```

## 定时事件

在 `~/.pi/pipiclaw/workspace/events/` 中创建 JSON 文件来触发定时任务：

- `immediate`
- `one-shot`
- `periodic`

示例：

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "Review your MEMORY.md files. Remove outdated entries, merge duplicates, ensure well-organized.",
  "schedule": "0 3 * * 0",
  "timezone": "Asia/Shanghai"
}
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `PIPICLAW_DEBUG` | 设为任意值启用调试模式，将完整上下文写入 `last_prompt.json` |
| `DINGTALK_FORCE_PROXY` | 设为 `true` 保留 axios 代理设置 |

## 开发

```bash
npm install
npm run build
npm run dev
```
