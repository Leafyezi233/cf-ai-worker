# CPG

CPG 是为 Cloudflare Workers 设计的 AI 网关。Hono 处理 API 请求，D1 保存网关配置与用量数据，React 管理界面作为 Worker 静态资源提供。

当前目录是隔离的本地开发副本。这里的 Worker、D1 和 R2 配置仅供本地运行；部署与远程数据库迁移命令会直接拒绝执行。

## 功能

- 为 OpenAI Chat Completions、Responses 和 Anthropic Messages 客户端提供统一网关入口。
- 按已配置的模型路由到上游，可设置模型别名、备用链、加权路由和密钥池。
- 支持流式响应、设备 Token、请求限流及用量记录。
- 在 React 管理界面维护上游、模型、设备和用量配置。
- 通过 Cloudflare D1 保存配置与运行数据，使用 Worker 静态资源托管管理界面。
- 管理端与用户控制台是两套独立前端：管理端打包到 `/__admin/` 独立产物，通过可配置的隐藏前缀访问；用户控制台是公开的 `/console`。

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

## 管理端入口

管理端（Providers / Models / Devices / 月卡 / 用量 / 设置等页面）不再挂在公开路径下，而是由 Worker 中间件 `worker/src/middleware/adminEntry.ts` 按 `ADMIN_PATH_PREFIX` 前缀分发：

- 前缀取自 `worker/wrangler.toml` 的 `[vars] ADMIN_PATH_PREFIX`；未配置时使用 `worker/src/utils/admin-path.ts` 里的内置示例值。
- 合法前缀为 6-80 位字母、数字、下划线或短横线，且不能是 `console`、`assets`、`__admin`、`api`、`v1`、`me`、`health`、`user`、`models` 等保留字；不合法时管理端整体不可访问。
- 管理端 API 只接受同源请求（校验 `Origin` / `Sec-Fetch-Site`），非 GET 请求必须带 `X-Admin-Request: 1` 头，否则返回 403。
- 管理端页面响应带 `Cache-Control: no-store` 与 `X-Robots-Tag: noindex, nofollow`。

管理端前端由 `web/vite.admin.config.ts` 单独构建到 `web/dist/__admin`，入口 `web/admin.html`；公开前端只保留 `/console`。

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

`pnpm build` 会依次构建公开前端与管理端前端。然后在两个终端分别启动 Worker 和前端开发服务器：

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

## 用户控制台

`/console` 是终端用户使用的控制台，包含账户概览、模型广场、视频任务、接入指南、API 密钥、用量与账单、账户与安全七个分区。访问根路径会跳转到 `/console`。

## 视频上游

视频模型按上游接口配置地址、模型标识、可用规格和报价。不同协议使用对应的请求格式，具体配置项以管理界面为准。

## 目录

- worker/：Cloudflare Worker、Hono API、网关及 D1 迁移。
- web/：React 管理界面。
- scripts/：本地隔离检查与受限命令入口。