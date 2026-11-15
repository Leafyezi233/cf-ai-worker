# CPG

CPG 是为 Cloudflare Workers 设计的 AI 网关。Hono 处理 API 请求，D1 保存网关配置与用量数据，React 管理界面作为 Worker 静态资源提供。

当前目录是隔离的本地开发副本。这里的 Worker、D1 和 R2 配置仅供本地运行；部署与远程数据库迁移命令会直接拒绝执行。

## 功能

- 为 OpenAI Chat Completions、Responses 和 Anthropic Messages 客户端提供统一网关入口。
- 按已配置的模型路由到上游，可设置模型别名、备用链、加权路由和密钥池。
- 支持流式响应、设备 Token、请求限流及用量记录。
- 在 React 管理界面维护上游、模型、设备和用量配置。
- 通过 Cloudflare D1 保存配置与运行数据，使用 Worker 静态资源托管管理界面。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | /v1/chat/completions | OpenAI Chat Completions |
| POST | /v1/responses | OpenAI Responses |
| POST | /v1/messages | Anthropic Messages |
| GET | /v1/models | 查询已启用的模型 |

本地 Worker 默认监听 8787 端口。完成本地配置并创建设备 Token 后，可以这样发送请求：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer ccs_your_device_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-configured-model",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

## 本地运行

需要 Node.js 和 pnpm。先安装依赖，并确认本地隔离配置：

```sh
pnpm install --frozen-lockfile
pnpm check:isolation
pnpm test:isolation
```

首次运行前，将 worker/.dev.vars.example 复制为 worker/.dev.vars，并为本地管理端生成独立凭据。不要填入生产密钥。

构建前端并初始化本地 D1：

```sh
pnpm build
pnpm db:migrate:local
```

然后分别在两个终端启动 Worker 和前端开发服务器：

```sh
pnpm dev:worker
```

```sh
pnpm dev:web
```

运行 Worker 测试和类型检查：

```sh
pnpm test
pnpm typecheck
```

## 隔离边界

本副本把 Worker、D1、R2 和网关地址设为本地目标。pnpm deploy、pnpm deploy:worker 与 pnpm db:migrate:remote 会拒绝执行。此保护约束仓库提供的命令入口，不会关闭机器上的全局 Wrangler 登录，也不是操作系统沙箱。

## 视频上游

视频模型按上游接口配置地址、模型标识、可用规格和报价。不同协议使用对应的请求格式，具体配置项以管理界面为准。

## 目录

- worker/：Cloudflare Worker、Hono API、网关及 D1 迁移。
- web/：React 管理界面。
- scripts/：本地隔离检查与受限命令入口。
