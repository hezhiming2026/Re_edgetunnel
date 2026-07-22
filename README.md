# 🚀 EdgeTunnel (Refactored)

> **致敬与鸣谢**：
> 本项目核心代理逻辑参考自开源社区的杰出贡献。特别感谢：
> *   **cmliu** ([cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)) - 原项目作者，提供了强大的面板与逻辑。
> *   **zizifn** ([zizifn/edgetunnel](https://github.com/zizifn/edgetunnel)) - 早期版本的贡献者。

---

> **EdgeTunnel (Refactored)** 是一个全新构建的 Cloudflare Workers 隧道代理方案。
> 它吸取了社区现有方案的设计思路，但采用**全模块化架构**从零重写，专为工程化部署和二次开发设计。

![Status](https://img.shields.io/badge/Status-Active-success)
![Author](https://img.shields.io/badge/Author-tianrking-blue)

---

## 📖 项目简介

这是一个运行在 Cloudflare 边缘网络上的轻量级隧道代理工具。

本项目对原有的单文件脚本进行了**彻底重构**，采用现代化的 **ESM 模块标准**，支持 **Wrangler CLI** 一键部署、本地调试以及 Git 版本管理。

它解耦了配置与核心逻辑，利用 **Cloudflare KV** 存储管理状态，并适配多种通信协议。旨在提供一个更符合工程化标准、易于扩展的 Serverless 网络编程范例，适合开发者学习 Worker 开发与 WebSocket 通信技术。

### ✨ 核心特性

- 🛡️ **协议支持**：支持 VLESS、Trojan 等主流协议。
- 📦 **模块化设计**：代码拆分为 `src/` 目录，职责分离（配置、逻辑、控制器），易于维护。
- 🛠 **工程化标准**：支持 `wrangler dev` 本地开发调试，告别在线编辑器的低效。
- 🔄 **订阅系统**：自动生成订阅链接，适配 Clash, Sing-box, Surge 等。
- ⚡ **性能优化**：利用 Cloudflare 全球边缘网络加速。

---

## 🛠 快速部署 (CLI)

请完全按照以下步骤进行部署。

### 1. 安装工具与登录
确保已有 Node.js 环境。

```bash
# 安装 Wrangler
npm install -g wrangler

# 登录 Cloudflare (浏览器授权)
npx wrangler login
```

### 2. 获取代码
```bash
git clone https://github.com/tianrking/Re_edgetunnel.git
cd Re_edgetunnel
```

### 3. 配置 KV 存储
创建一个 KV 命名空间用于存储配置：

```bash
npx wrangler kv namespace create edgetunnel
```

记下终端输出的 `id` (例如 `095b6650...`)，然后打开 `wrangler.toml` 文件，修改 `[[kv_namespaces]]` 部分：

```toml
[[kv_namespaces]]
binding = "KV"
id = "替换为你刚刚获取的ID"
```

### 4. 部署上线
```bash
npx wrangler deploy
```

部署成功后，控制台会显示 Worker 的访问网址（例如 `https://edgetunnel.xxx.workers.dev`）。

---

## ⚙️ 进阶配置

### 自主可控运行方式

默认部署不再从第三方 GitHub、订阅转换站、代理回退站或外部管理页面加载运行时内容。登录页和管理页已内置；优选地址使用本地生成，并可通过认证后的 `POST /admin/ADD.txt` 保存自己的地址列表。

以下远程能力默认关闭，只有明确配置为自己控制的 HTTPS 服务时才启用：

- `订阅转换配置.SUBAPI` 与 `订阅转换配置.SUBCONFIG`：自建订阅转换服务和配置文件。
- `本地规则集URL`：自建 Sing-box 规则集目录（例如 `https://rules.example.com`）。
- `ECH_DOH_URL`：自建或自行选择的 HTTPS DoH 服务；仅在启用 ECH 时使用。
- `ALLOW_REMOTE_USAGE_API=true`：允许管理员保存的 HTTPS 用量 API。未设置时不会发起该请求。
- `DNS_RESOLVER` 与 `DNS_RESOLVER_PORT`：自有 DNS 上游；未设置时 VLESS UDP/DNS 转发关闭。
- `PROXY_CHECK_HOST`、`PROXY_CHECK_PORT` 与 `PROXY_CHECK_PATH`：自有 HTTP 检测端点；未设置时后台上游代理检测关闭。
- `客户端DNS`：仅在你明确填写时写入 Clash 配置，项目不再注入公共 DNS。
- `LOCATIONS_API`：自有 HTTPS 位置数据接口；未设置时 `/locations` 明确返回 501，不再请求公共位置接口。

仓库不包含上游单文件备份，也不会通过 DoH 或 GitHub 地址解析代理。Cloudflare 平台 API 属于部署平台能力；Telegram、伪装站、订阅转换器、规则集和用量 API 都是显式选择、默认关闭的可选集成。

### 协议支持边界

- VLESS over WebSocket/TLS：完整支持，已通过真实 Cloudflare TCP 转发测试。
- Trojan over WebSocket/TLS：完整解析，并生成独立的 Trojan URI（不携带 VLESS 专用 `encryption=none`）。
- VLESS DNS：仅在配置自有 `DNS_RESOLVER` 时启用。
- SOCKS5/HTTP：作为可选上游代理使用，不是入站客户端协议。
- Hysteria2、TUIC、WireGuard 等依赖原生 UDP/QUIC 的协议不在支持范围；Cloudflare Workers 当前主要提供入站 HTTP/WebSocket 和出站 TCP socket，不能可靠实现这些协议。

不要把 `跳过证书验证` 设为 `true`，除非你了解由此带来的中间人攻击风险。

### 绑定自定义域名
在 `wrangler.toml` 中添加 `routes`：

```toml
routes = [
	{ pattern = "tunnel.your-domain.com", custom_domain = true }
]
```
重新部署：`npx wrangler deploy`

### 设置管理员密码与协议凭据

部署前必须设置强随机 `ADMIN`。`UUID` 必须是 RFC 4122 v4 格式；未设置时会由 `ADMIN` 与可选 `KEY` 确定性派生。建议分别设置，避免把 UUID 同时当作后台密码。

```toml
[vars]
ADMIN = "你的强随机后台密码"
UUID = "8a5ea040-33ff-4227-88bd-414bb865e59b"
```

---

## ⚠️ 免责声明

本项目仅供技术研究与学习使用，请勿用于任何非法用途。作者不对使用本项目产生的任何后果负责。
