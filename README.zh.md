# dsh-desktop-bridge

给**正在运行的** DSH（DeepSeek Harness）宿主——桌面端应用，或一个 `dsh web`
服务——开一个带令牌鉴权的本机 HTTP 接口。任何本地程序都能调用它：脚本、构建工具、
别家的 agent、`curl`。

> **安全敏感。** 插件启用期间，任何能读到 `<DSH_HOME>/desktop-bridge.json`
> 的进程，都能列出你的会话、读取它们的事件、往里面发消息、并创建新会话——每个新会话
> 都会启动一个以你的权限运行的 agent。安装前请读 [SECURITY.md](./SECURITY.md)，
> 不用的时候把插件停掉。
>
> English documentation: [README.md](./README.md)。

## 为什么需要它

DSH 把会话控制留在宿主进程里，也就是 `sessionController` 服务。这是有意为之，也正
因为如此，常规入口都够不着一个已经在跑的应用：

- `dsh --profile desktop …` 直接拒绝——`error: profile "desktop" is managed
  exclusively by the Electron application`。桌面端独占的 profile，CLI 既不能启动
  也不能往里装插件。
- SDK / ACP 那些入口会启动**它们自己的**宿主，因此够不着你正在看的那个实例里的会话。

本插件跑在那个宿主**内部**，把它的 `sessionController` 以 bearer 令牌保护的形式重新
发布到一个回环端口上。除此之外什么都没有改变：不启动第二个 profile，桥接自身不写会话
文件，也不对外网开放。

### 与其他同名/同类包的区别

| 包 | 机制 | 谁能用它驱动 DSH |
|---|---|---|
| **本插件** | 回环 HTTP + bearer 令牌 | 任何本地进程、任何语言、`curl` |
| `dsh-session-bridge` | 注册在 DSH 内部的 agent 工具 | 只有 DSH 自己的 agent，且要在它的对话里 |
| `dsh-agent-bridge` | 通过配方拉起别的 agent CLI | 别的 agent CLI，不是任意程序 |
| `dsh-desktop-bridge`（npm 上另一位作者的包） | 只读的 fetch 路由 | 只读，不能创建与发送 |

npm 上的 `dsh-desktop-bridge` 已被一个不相关的只读包占用，所以本包以 scope 形式发布。

## 环境要求

- DSH 的 profile 组合里包含 `@deepseek-ai/dsh-web-app`（桌面端和 `dsh web` 都满足）。
  该 bundle 挂载 `@deepseek-ai/dsh-api-session-controller`，它提供本插件注入的
  `sessionController` 服务。
- 随包的命令行客户端需要 Node.js ≥ 20。插件本体用宿主的运行时，且**零依赖**。

## 安装

### 让 agent 帮你装

如果你的会话用的是 `cordis` 预设，agent 手里有插件管理工具，整件事它自己能办完——
直接说：

```
安装插件 @ignotuss/dsh-desktop-bridge
```

`standard` 和 `ptc` 预设把那个工具关掉了；在这两个预设下 agent 没有任何安装手段，
只能退回到下面的命令。想在桌面端用"对话即安装"，先在 设置 → Agent 预设 里换成
`cordis`。

### CLI 管理的 profile（`web`、`tui`、`headless`）

```bash
dsh plugin --profile web add @ignotuss/dsh-desktop-bridge
```

本包是 bundle：它自带的 `cordis.patch.yml` 会挂载插件，所以**装上即启用**。重启该
profile（或在开启了 HMR 的场合交给它），然后在 设置 → 插件 里确认状态为已启用。

### DSH 桌面端

桌面端独占自己的 profile，CLI 按设计拒绝它。请在侧栏 **插件 → 添加插件** 里填入包名
（或本地检出目录），并选择 **立即启用**。以后改完源码要生效，把该插件的开关关掉再打开
即可——在线的 profile 会就地重组合，不需要重启整个应用。

## 使用

装上包之后还会得到一个 `dsh-desktop-bridge` 命令：

```bash
dsh-desktop-bridge list
dsh-desktop-bridge create ~/projects/demo "发版排查"
dsh-desktop-bridge events session-1f0e…-… 50
dsh-desktop-bridge send session-1f0e…-… "请总结一下失败的测试。"
```

每个请求都要带上 `<DSH_HOME>/desktop-bridge.json` 里的 bearer 令牌。该文件由插件在
挂载时写入、卸载时删除：

```json
{
  "version": 1,
  "address": "127.0.0.1",
  "port": 63339,
  "token": "…64 位十六进制…",
  "pid": 30820,
  "startedAt": "2026-10-02T02:31:07.114Z"
}
```

端口和令牌每次挂载都会重新随机，所以重载之后要重新读文件，不要缓存。

| 方法 | 路径 | 请求体 / 查询 | 结果 |
|---|---|---|---|
| `GET` | `/v1/sessions` | — | `200 {items: […]}`，宿主的会话列表（含实时投影） |
| `POST` | `/v1/sessions` | `{cwd, title?}` | `201` 返回新建会话；`cwd`/`title` 不合法为 `400`；被配置禁用或超出白名单为 `403` |
| `GET` | `/v1/sessions/{id}/events` | `?limit=1..100`（默认 30） | `200 {sessionId, events: […]}`，事件日志的尾部 |
| `POST` | `/v1/sessions/{id}/messages` | `{text}`（1–4096 字节） | `200 {accepted, requestId}`；文本作为一条用户回合追加 |

`curl` 示例：

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/sessions"
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cwd":"/home/me/projects/demo","title":"发版排查"}' \
  "http://127.0.0.1:$PORT/v1/sessions"
```

带浏览器 `Origin` 头的请求一律拒绝，且 `Host` 必须写明回环地址与端口——因此网页即使
通过 DNS 重绑定也够不着这个桥。

### 等待本轮回复

默认的 `send` 在请求被接收后立即返回。加 `--wait` 后，等待**本次请求所属的 turn**
完成，而不是只等会话进入空闲：

```bash
dsh-desktop-bridge send session-1f0e…-… --wait --timeout 45 "跑完测试再回复。"
```

`--timeout` 单位秒，默认 30，允许 1–3600。命令输出 JSON，其中 `status` 为：

- `replied` —— turn 已完成；`turn` 和 `reply` 是回复文本。
- `input-required` —— 宿主在等人处理；`pendingInput` 为 `approval`、`question` 或
  `other`。
- `timeout` —— 超时；`timeoutSeconds` 原样返回，已接收的请求继续运行，不取消、不重发。
- `turn-ended` —— turn 因其他原因结束；`reason` 记录原因。

退出码：`0` 已回复，`124` 超时，`3` 需要人工输入，`1` 其他 turn/HTTP 失败，`2` 用法
错误。不带 `--wait` 时，`send` 保持原来的立即响应 `{accepted, requestId}`。等待按
request id 和 turn 归属，因此队列里前一轮或其他会话的回复不会变成结果。等待会从发送前
记录的游标向后分页，繁忙的事件日志不会吞掉本次请求或回复。观察调用受剩余超时约束；
CLI 的等待请求使用原生 HTTP，不会被 fetch 默认响应头超时截断。HTTP 调用也可使用
`POST /v1/sessions/{id}/messages?wait=1&timeout=<秒>`。

## 配置

插件会读取补丁行里可选的 `config`，每个键都可省略，省略时即为下面这种宽松默认值：

```yaml
- id: desktop-bridge
  config:
    allowCreate: false        # 默认 true；false 直接拒绝 POST /v1/sessions
    auditLog: true            # 默认 true；每个请求一行 JSON
    cwdAllowlist:             # 默认 []，不限制
      - 'C:\work'
```

- **`allowCreate`** —— 设为 `false` 后，列表、读取、发消息照常可用，但不能再启动新的
  agent。
- **`auditLog`** —— 每个请求向 `<DSH_HOME>/desktop-bridge.log` 追加一行 JSON：时间、
  方法、路径、路由、状态码、耗时，以及目标目录或会话 id。**不记录令牌，也不记录消息
  正文。**
- **`cwdAllowlist`** —— 非空时，新会话只能建在这些目录之内（含子目录）。

`POST /v1/sessions` 传入的路径必须是**已存在**的目录；桥接不会替你创建。

## 兼容性

兼容性按已发布的 `@deepseek-ai/dsh-api-session-controller` 类型契约核对：
DSH `0.2.0-rc.2` 提供 `inspect`，DSH `0.2.2-rc.5` 提供 `events`。插件优先用
`events`，旧版回退 `inspect`。两个契约都把 `prompt` 的 `mode` 定义为
`queue | steer`，因此发消息使用 `queue`。

已在 macOS DSH NEXT 2.0.24-next（内置 DSH 0.2.2-rc.5）实测：桌面未退出，
CLI 提示进入同一会话并在界面显示回复，CLI 可读回。

插件只是五个 `sessionController` 方法之上的薄层——`list`、`inspect`/`events`、
`prompt`、`create`、`rename`——不依赖其他内部 API。若某个 DSH 版本改了方法名，
相应路由会返回 `500 DSH request failed`，真实错误写进审计日志，应用其他部分
不受影响。

注入不到服务时，插件会在启动日志里报 `sessionController is unavailable`，而不是挂载
一个半死不活的桥。

## 开发

```bash
node --test          # 45 个测试：路由、策略、审计、等待归属、descriptor 生命周期
```

测试占用临时回环端口并使用桩 controller，不需要跑着 DSH。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
