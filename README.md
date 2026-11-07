# dsh-github-accel

DeepSeek Harness 插件：为 GitHub 访问加速。自动探测可用镜像，改写 GitHub 链接，并通过**当前最快的健康镜像**下载文件、读取文本或浅克隆仓库；单个镜像失败时自动换下一个。

> A DeepSeek Harness bundle that probes GitHub mirrors, rewrites GitHub URLs, and downloads or shallow-clones through the fastest healthy mirror.

## 为什么需要它

直连 GitHub 的速度在不同网络、不同时段差异很大，公开镜像又经常失效、证书过期或限速。与其在配置里写死一个镜像，这个插件把选择权交给测量：

- **探测**：并发请求每个镜像上的同一个 raw 文件，记录首字节延迟与吞吐。
- **排序**：按实测吞吐排序，`direct`（直连）也参与排名，直连更快时不会绕远路。
- **回退**：下载/克隆时逐个尝试候选，失败自动换下一个，并删除半成品。
- **缓存**：探测结果缓存 10 分钟，避免每次调用都重新测速。

## 安装

要求 DeepSeek Harness `>= 0.2.2-rc.1`、Node.js `>= 20`。

在 DSH 中安装这个 bundle（任选其一）：

- 「设置 → 插件」中从 npm 安装 `dsh-github-accel`；
- 或让 Agent 调用 `plugin_manager`：

```json
{ "action": "install_bundle", "target": "dsh-github-accel" }
```

开发时可以直接安装本地目录：

```json
{
  "action": "install_bundle",
  "target": "C:\\path\\to\\dsh-github-accel"
}
```

安装后无需重启，插件会注册 5 个工具；用 `github_accel_probe` 验证网络即可。

## 提供的工具

| 工具 | 作用 | 是否联网 |
| --- | --- | --- |
| `github_accel_resolve` | 解析 GitHub 链接，列出各镜像的改写结果 | 否 |
| `github_accel_probe` | 实测所有镜像与直连，按吞吐排序并缓存 | 是 |
| `github_accel_download` | 下载文件 / Release 资产 / 源码包，失败自动换镜像 | 是 |
| `github_accel_clone` | 浅克隆仓库，失败自动换镜像 | 是 |
| `github_accel_read` | 读取小型文本文件（raw / blob 链接） | 是 |

### `github_accel_resolve`

```json
{ "url": "https://github.com/nodejs/node/releases/download/v22.0.0/node-v22.0.0-win-x64.zip" }
```

返回 `kind: "release"`、`owner`/`repo`/`ref`/`file`，以及按当前探测结果排序的 `candidates`。`purpose: "clone"` 会额外给出支持 `git clone` 的镜像地址。

### `github_accel_probe`

```json
{ "force": true }
```

输出示例（真实测量，网络状况不同结果会变化）：

```text
GitHub mirror probe at 2026-11-07T05:39:59.092Z
source: https://raw.githubusercontent.com/nodejs/node/main/README.md
direct       FAIL Timed out after 15000 ms
ghproxy      206  1008 ms  27.8 KiB/s   41.7 KiB
ghfast       FAIL fetch failed (UND_ERR_CONNECT_TIMEOUT)
gh-proxy     206  1396 ms  11.4 KiB/s   41.7 KiB
ghproxy-cc   FAIL fetch failed (CERT_HAS_EXPIRED)
moeyy        FAIL fetch failed (UND_ERR_CONNECT_TIMEOUT)
jsdelivr     FAIL fetch failed (ECONNRESET)
recommended: ghproxy
```

### `github_accel_download`

```json
{
  "url": "https://github.com/octocat/Hello-World/archive/refs/heads/master.zip",
  "dest": "./downloads/hello.zip",
  "overwrite": true
}
```

先写 `*.part` 临时文件再原子改名，失败不会留下半个文件。`dest` 可以是一个已存在的目录，此时沿用资产名。

### `github_accel_clone`

```json
{ "repo": "octocat/Hello-World", "dest": "./repos/hello", "depth": 1 }
```

等同于 `git clone --depth 1 --single-branch --no-tags <镜像地址> <dest>`，但会在失败时清理目录并换镜像。目标目录必须不存在或为空。

### `github_accel_read`

```json
{ "url": "https://github.com/octocat/Hello-World/blob/master/README", "maxBytes": 4096 }
```

`blob` 链接会自动转换为 raw 地址；超过 `maxBytes` 时返回 `truncated: true`。

## 配置

所有字段都可选，默认值见 `lib/core.js`。在插件行里覆盖：

```yaml
- id: dsh-github-accel
  name: dsh-github-accel
  config:
    defaultMirror: auto          # auto = 按探测排序；或写镜像 id，如 ghproxy
    directFallback: true         # 镜像全失败后是否尝试直连
    probeTtlSeconds: 600         # 探测结果缓存时间
    timeoutMs: 20000             # 单次下载/读取超时
    probeTimeoutMs: 15000        # 单个镜像探测超时
    probeBytes: 65536            # 每次探测读取的字节数
    probeUrl: https://raw.githubusercontent.com/nodejs/node/main/README.md
    cloneDepth: 1                # 默认浅克隆深度
    cloneTimeoutMs: 300000       # 单次克隆超时
    maxReadBytes: 262144         # github_accel_read 默认上限
    trustSystemCa: true          # 合并系统证书库，适配 TLS 审计代理
    mirrors:                     # 覆盖内置镜像表
      - { id: ghproxy, label: ghproxy.net, mode: prefix, base: 'https://ghproxy.net/' }
      - { id: kkgithub, label: kkgithub.com, mode: host, base: 'https://kkgithub.com', hosts: [github.com], caps: [web, clone] }
```

### 镜像的三种改写方式

| `mode` | 改写规则 | 适用 |
| --- | --- | --- |
| `prefix` | `<base>/<原始 GitHub URL>` | ghproxy 系列，raw / Release / 源码包 / clone 都能用 |
| `host` | 替换 `github.com` 等主机名，保留路径 | kkgithub 一类整站镜像 |
| `jsdelivr` | `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` | 仅 raw 文件；有 CDN 缓存，新提交可能延迟 |

`caps` 声明该镜像支持的能力（`raw`、`release`、`archive`、`web`、`clone`），不匹配的链接不会生成该镜像的候选。

内置镜像：`ghproxy.net`、`ghfast.top`、`gh-proxy.com`、`ghproxy.cc`、`github.moeyy.xyz`、`kkgithub.com`、`jsDelivr`。镜像可用性变化很快，所以默认按实测结果排序，而不是写死顺序。

### 证书与 TLS 审计代理

有些环境（公司代理、部分安全软件）会用自己的根证书重签 TLS。`curl` 能用而 Node 的 `fetch` 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，就是这种情况。

`trustSystemCa: true`（默认）会在插件启动时把操作系统证书库合并进 Node 的默认根证书列表，只影响当前进程，不修改任何系统设置。若你不希望这样，设为 `false`，此时需要自行配置 `NODE_EXTRA_CA_CERTS`。

## 安全说明

- 只改写 `github.com`、`raw.githubusercontent.com`、`codeload.github.com`、`api.github.com`、`gist.github.com` 的链接，其他 URL 一律拒绝，避免变成任意 URL 代理。
- 不保存任何凭据、Token 或 Cookie。镜像只适合**公开仓库**；私有仓库的鉴权信息不应交给第三方镜像。
- 克隆通过 `spawn('git', [...])` 传参数组执行，不经过 shell，仓库名和路径不会被解释成命令。
- 下载先写临时文件再改名；覆盖已有文件必须显式 `overwrite: true`。
- 镜像本身是第三方服务：它们能看到你请求的公开仓库路径，请自行评估。

## 已知限制

- 只支持公开 GitHub 资源；私有仓库、需要登录的 API 不在范围内。
- 探测样本是 `raw.githubusercontent.com` 上的固定文件，代表 raw 下载吞吐；`git clone` 的排序只是近似，最终仍以实际尝试为准。
- jsDelivr 只处理 raw 文件，且对刚推送的提交有缓存延迟。
- `github_accel_clone` 需要 PATH 中有 `git`。
- 镜像域名可能失效或证书过期，插件会把它们标记为失败并继续使用其余候选；长期使用建议定期查看 `github_accel_probe` 的输出。

## 开发

```bash
npm test          # node:test，覆盖 URL 解析、改写、配置归一化与排序
```

目录结构：

```text
index.js          # 工具注册、网络与文件传输
lib/core.js       # 纯函数：配置、URL 解析、镜像改写、排序
test/core.test.mjs
cordis.patch.yml  # bundle 入口
locale/           # 插件标题与描述
icon.svg
```

安装到本地 DSH 后，用 `github_accel_resolve`（不联网）确认注册成功，再用 `github_accel_probe` 验证网络。

## License

MIT © 2026 SYSTEMMBRBOOT
