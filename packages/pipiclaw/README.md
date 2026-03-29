# pipiclaw

Pipiclaw 是一个接入钉钉的 AI Card 机器人，把 [pi-coding-agent](../coding-agent) 带到钉钉对话里，支持过程性 AI 卡片、最终 Markdown 回复、内置 Slash 命令、技能扩展和定时事件。

## 功能

- 钉钉 Stream 模式接收消息，自动重连
- 过程性思考和执行信息通过 AI Card 展示，最终答复独立快速返回
- 内置 Slash 命令：`/help`、`/new`、`/compact`、`/session`、`/model`
- 忙碌时默认将普通新消息作为 steer 送入当前任务，也支持显式 `/steer`、`/followup`、`/stop`
- 每个 DM / 群聊独立工作空间
- 支持全局和频道级 `SOUL.md`、`AGENTS.md`、`MEMORY.md`
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
- `workspace/AGENTS.md`
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

以下命令由 Pipiclaw 直接处理，不会作为普通 prompt 发送给模型。

### 空闲时可用

- `/help`
  显示帮助
- `/new`
  开启新会话
- `/compact [instructions]`
  手动压缩当前会话上下文
- `/session`
  查看当前会话状态、消息统计、token 使用和模型信息
- `/model [provider/modelId|modelId]`
  查看当前模型，或用精确匹配切换模型

说明：

- `/model` 无参数时返回当前模型和可用模型列表
- `/model <ref>` 只支持精确匹配

### 忙碌时可用

- 普通消息
  默认按 `steer` 处理，在当前工具步骤结束后尽快转向
- `/help`
  显示帮助
- `/stop`
  停止当前任务
- `/steer <message>`
  显式指定一次 steer，改变当前任务方向
- `/followup <message>`
  将一条新请求排到当前任务完成之后再执行

说明：

- busy 时普通消息默认等价于 `/steer <message>`
- `/steer` 更适合纠偏、补充限制条件、修改当前任务方向
- `/followup` 更适合“等这件事做完，再继续做下一件事”
- 未被 Pipiclaw 拦截的其他 slash 输入，仍会按 `AgentSession.prompt()` 的原有逻辑处理

## Workspace Files

Pipiclaw 只会自动识别并使用下面这些 workspace 文件或目录：

- `SOUL.md`
- `AGENTS.md`
- `MEMORY.md`
- `skills/`
- `events/`

`TOOLS.md` 当前不受支持。即使你手工创建了它，也不会被自动加载或生效。

### Global And Channel Scope

Pipiclaw 同时支持：

- 全局 workspace 文件：`~/.pi/pipiclaw/workspace/`
- 渠道级文件：`~/.pi/pipiclaw/workspace/dm_xxxx/` 或 `group_xxxx/`

它们的关系如下：

| 名称 | 全局位置 | 渠道级位置 | 生效方式 |
|------|----------|------------|----------|
| `SOUL.md` | `workspace/SOUL.md` | 不支持 | 仅使用全局文件。渠道级 `SOUL.md` 不会被读取。 |
| `AGENTS.md` | `workspace/AGENTS.md` | `<channel>/AGENTS.md` | 叠加。先读取全局，再追加渠道级，不是替换。 |
| `MEMORY.md` | `workspace/MEMORY.md` | `<channel>/MEMORY.md` | 合并。全局记忆和渠道记忆都会一起进入上下文。 |
| `skills/` | `workspace/skills/` | `<channel>/skills/` | 合并。两边的技能都会加载；如果同名，渠道级覆盖全局。 |
| `events/` | `workspace/events/` | 不支持 | 仅支持全局事件目录。 |
| `.channel-meta.json` | 不支持 | `<channel>/.channel-meta.json` | 运行时自动维护，用于主动发送和重启恢复，不建议手工编辑。 |
| `context.jsonl` | 不支持 | `<channel>/context.jsonl` | 运行时自动维护，保存结构化上下文。 |
| `log.jsonl` | 不支持 | `<channel>/log.jsonl` | 运行时自动维护，保存消息历史。 |

### File Intent

- `SOUL.md`
  定义 Pipiclaw 的身份、语气、默认语言和回复风格。首次运行生成的只是说明模板，你需要替换成真实内容。
- `AGENTS.md`
  定义行为规则、工具使用策略、安全约束和项目工作流。全局文件定义通用规则，渠道级文件补充该渠道的特定规则。
- `MEMORY.md`
  定义持久记忆。适合存长期偏好、项目背景、联系人信息、长期约束等。
- `skills/`
  存放自定义技能。适合放可复用的 CLI 工具、脚本和 skill 说明。
- `events/`
  存放定时事件定义。只支持全局目录，不支持放到单个 channel 目录里。

## 工作空间布局

```text
~/.pi/pipiclaw/
├── channel.json
├── auth.json
├── models.json
├── settings.json
└── workspace/
    ├── SOUL.md
    ├── AGENTS.md
    ├── MEMORY.md
    ├── skills/
    ├── events/
    └── dm_{userId}/
        ├── AGENTS.md
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
