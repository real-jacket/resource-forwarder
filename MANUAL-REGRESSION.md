# 人工回归清单

适用于改完 background / page-bridge / forwarder-service 后，验证代理热路径未被破坏。
按"先准备 → 核心代理 → 改动专项"顺序跑，每一步都标注**怎么观察结果**。
跑完第 1、3、4、5 节即覆盖大多数代理变更。其余是 sanity check。

## 0. 准备环境

```bash
# 终端 1：启动 service + extension watch
pnpm dev
```

加载扩展：Chrome → `chrome://extensions/` → 开发者模式 → "加载已解压的扩展" → 选 `packages/extension-shell/dist`。

**第一次接入**：service 启动时控制台会打印 `auth token file: <path>`。`cat` 文件取出 UUID，粘贴到「设置 → 服务 token」并保存。状态条变为「服务在线」即同步成功。重启 service 不会换 token——只要不删 `~/.resource-forwarder/token` 就一直复用。

固定打开三个观察窗：

- **Service 终端**（终端 1）：看请求是否进来
- **Background DevTools**：`chrome://extensions/` → 该扩展 → "检视视图：Service Worker" → Console
- **Page DevTools**：F12 在测试页

准备**已知 api_forward 规则**的项目（例：`https://example.com/*` → `http://127.0.0.1:9999`），并起本地 mock 上游：

```bash
# 终端 2：mock 上游
node -e "require('http').createServer((req,res)=>{console.log(req.method,req.url);res.end(JSON.stringify({ok:true,url:req.url}))}).listen(9999)"
```

## 1. 核心代理路径（必须不破）

### 1.1 fetch 命中规则

测试页 Console：

```js
fetch("https://example.com/api/profile?x=1").then(r => r.json()).then(console.log)
```

期望：

- 终端 2 输出 `GET /api/profile?x=1`
- 返回 `{ok:true, url:"/api/profile?x=1"}`
- service 终端无 502/404
- options "命中日志" → `outcome: matched`，目标 URL 正确

### 1.2 fetch 带 body

```js
fetch("https://example.com/api/echo", {
  method: "POST",
  headers: {"content-type": "application/json"},
  body: JSON.stringify({hello: "world"})
}).then(r => r.json()).then(console.log)
```

期望：mock 上游收到 `POST /api/echo`，body 透传。

### 1.3 XHR 命中规则

```js
const x = new XMLHttpRequest();
x.open("GET", "https://example.com/api/xhr");
x.onload = () => console.log(x.status, x.responseText);
x.send();
```

期望：返回 200，`responseText` 是 mock JSON。

### 1.4 上游返回二进制（无 Content-Type 默认走二进制路径）

```js
fetch("https://example.com/api/binary").then(r => r.arrayBuffer()).then(b => console.log(b.byteLength))
```

期望：byteLength 与上游实际一致，没有被 utf-8 损坏。

## 2. DNR（asset_redirect）

### 2.1 全局 project 的 redirect

- 配 asset_redirect：`https://*.cdn.example.com/*.js` → `http://localhost:8000/replaced.js`
- `python3 -m http.server 8000`，目录里有 `replaced.js`
- 测试页 `<script src="https://foo.cdn.example.com/app.js"></script>`

期望：Network 看到 redirect 到 localhost:8000，加载 `replaced.js`。

### 2.2 站点 scoped redirect 切换 tab

- 项目 site pattern `https://example.com/tables/*`
- 打开 `https://example.com/`（不匹配）→ 资源**不被** redirect
- 切到 `https://example.com/tables/abc`（匹配）→ 资源**被** redirect

期望：200ms 内 DNR 切换；background DevTools 能看到 `applyDynamicRules` 被调用。

### 2.3 跨页面 initiator 隔离（host-only project）

- 项目 siteHosts=`["a.example.com"]`（**不设** siteMatchPatterns，对应导入自 Resource Override 的典型形态）
- asset_redirect 规则 host=`a.example.com`，pathGlob=`/static/foo.js`，redirect → `http://localhost:8000/foo.js`
- 打开 `https://a.example.com/` 上的页面，请求 `/static/foo.js` → **被** redirect（同源命中）
- 打开任意其它页面（例如 `https://example.org/`），在 Console 跑：

  ```js
  fetch("https://a.example.com/static/foo.js").then(r => r.text()).then(t => console.log(t.length))
  ```

  期望：**不被** redirect（响应来自上游 a.example.com，而不是 localhost）。在 background DevTools 跑 `await chrome.declarativeNetRequest.getDynamicRules()`，可看到该规则带 `initiatorDomains: ["a.example.com"]`。

  这是 DNR 同源 escape hatch 被移除后的预期：sidepanel 视角下「未匹配」的页面不会再触发该项目的资源替换。

## 3. 写锁专项

### 3.1 options 连点

options 页 1 秒内连点某项目"启用/停用"按钮 8 次。

期望：

- 最终状态 = 最后一次点击的状态（之前可能因 lost-update 停在中间）
- background DevTools 无报错
- service 端 `cat .resource-forwarder/workspace.json | jq '.projects[].enabled'` 与 UI 一致

### 3.2 复制项目期间不卡其他写

- 选一个有 5+ 条规则的项目，点"复制"
- 立刻在另一行点别的项目"启用/停用"

期望：两个操作都成功，最终都生效，无顺序错乱。

### 3.3 写锁不阻塞代理

测试页 Console 起循环 fetch：

```js
const t = setInterval(() => fetch("https://example.com/api/heartbeat").catch(() => {}), 200)
// 验完用 clearInterval(t) 停掉
```

同时在 options 页连点"复制"或编辑规则。

期望：service 终端 heartbeat 请求**不停顿、不堆积**；background DevTools 中 `inflightForwards` 无异常增长。

## 4. abort listener 清理

### 4.1 复用 AbortController

```js
const ctrl = new AbortController();
for (let i = 0; i < 100; i++) {
  fetch("https://example.com/api/ping?i=" + i, { signal: ctrl.signal }).catch(() => {});
}
setTimeout(() => ctrl.abort(), 1000);
```

期望：

- 1000ms 之前的请求正常完成
- 之后未完成的被中断
- Console 无 `MaxListenersExceededWarning`，不抛错即合格

### 4.2 主动 abort 走干净

```js
const c = new AbortController();
fetch("https://example.com/api/long", { signal: c.signal }).catch(e => console.log("aborted:", e.name));
setTimeout(() => c.abort(), 100);
```

期望：

- Console 输出 `aborted: AbortError`
- service 终端能看到该请求被切断
- background DevTools `inflightForwards` 在 abort 后立即清空（可在 background console `inflightForwards.size` 验）

## 5. /forward 拒绝原因

### 5.1 已禁用规则的 hint

extension workspace 上禁用一条 api_forward 规则，记下其 id，绕过 page-bridge：

```bash
curl -X POST http://127.0.0.1:5178/forward \
  -H "content-type: application/json" \
  -H "origin: chrome-extension://test" \
  -d '{"url":"https://example.com/api/x","method":"GET","headers":{},"matchedRuleId":"<被禁用规则的 id>"}'
```

期望：返回 404，body：

```json
{"message":"matchedRuleId \"...\" exists but is disabled, wrong kind, or no longer matches the request."}
```

options "命中日志" 中能看到对应 `errorMessage`。

### 5.2 不存在的 hint

```bash
curl -X POST http://127.0.0.1:5178/forward \
  -H "content-type: application/json" \
  -H "origin: chrome-extension://test" \
  -d '{"url":"https://example.com/api/x","method":"GET","headers":{},"matchedRuleId":"nope-not-real"}'
```

期望：404，message 含 `not found in service workspace`。

### 5.3 不带 hint（老路径）

```bash
curl -X POST http://127.0.0.1:5178/forward \
  -H "content-type: application/json" \
  -H "origin: chrome-extension://test" \
  -d '{"url":"https://example.com/api/x","method":"GET","headers":{}}'
```

期望：走 `pickMatchingRule`，行为同改之前；没规则匹配 → 404 message 是 `"No matching api_forward rule."`。

## 6. service 离线降级

```bash
# 终端 1 按 Ctrl+C 杀掉 service
```

测试页：

```js
fetch("https://example.com/api/profile").then(r => r.json()).then(console.log).catch(e => console.error("err", e))
```

期望：

- 不报错、不挂
- 实际走原生 fetch（DNS 解析 example.com 会失败，失败方式应与"未装 extension"一致）
- background DevTools 无未捕获 promise rejection
- 重启 `pnpm dev:service` 后下次 fetch 自动恢复转发

## 7. sidepanel 视觉

打开 sidepanel，找一条**长 URL/路径**的规则：

- 长 URL 在容器边界处自动换行（CSS `overflow-wrap: anywhere`）
- 不应横向溢出
- 不应有可见零宽字符或异常断点

### 7.1 DNR 已注册徽章

前置：保留几条 asset_redirect 规则（让 `chrome.declarativeNetRequest.getDynamicRules()` 返回非空）。

- 当前页面**匹配**任一 enabled project：hero 区出现 `N 条 DNR 已注册` 徽章，颜色为中性灰（`.sp-badge.neutral`），N 与 background 内 `await chrome.declarativeNetRequest.getDynamicRules()` + `getSessionRules()` 长度之和一致。
- 切到一个**未匹配**任何 project 的页面（例如 `about:blank` 后再打开 `https://example.org/`，project 中没有该站点）：徽章变为橙色 `.sp-badge.warning`，提示用户当前页面在 sidepanel 视角下未匹配，但 Chrome 里仍注册着 N 条 DNR 规则。
- N 为 0 时徽章应隐藏，不出现空徽章。

### 7.2 DNR apply 失败自愈

- 在 background DevTools 给 `chrome.declarativeNetRequest.updateDynamicRules` 临时打断点并抛错，触发一次 commitWorkspace（在 options 切换一条规则）。
- 期望：sidepanel `warnings` 出现「DNR 规则应用失败」一条；`lastAppliedDnrFingerprint` 被清空。
- 移除断点，下次 commitWorkspace 或 alarms tick（≤ 1 分钟）应重新成功 apply 而**不被 fingerprint 检查短路**，sidepanel `N 条 DNR 已注册` 数恢复一致。

## 8. token 鉴权与 Host 防御

### 8.1 token 缺失时拒绝

设置页清空 token 并保存（直接清掉再点保存按钮，应当提示"请粘贴 token 内容"）。
绕过扩展直接 curl：

```bash
curl -X POST http://127.0.0.1:5178/forward \
  -H "content-type: application/json" \
  -H "host: 127.0.0.1:5178" \
  -d '{"url":"https://example.com/api/x","method":"GET","headers":{}}'
```

期望：HTTP 401，body 含 `Missing or invalid bearer token`。

### 8.2 Host 头白名单

```bash
curl -i http://127.0.0.1:5178/health -H "host: evil.example.com"
```

期望：HTTP 403，`Host header not in localhost allowlist`。
DNS rebinding 攻击只能伪造非 loopback 的 Host，因此被拒绝。

### 8.3 token 错误后扩展提示

设置页粘一个错的 token（例：故意删一位）→ 保存。
状态行报"服务 token 校验失败，请在设置页重新粘贴 token。" 此时所有 PUT / POST 接口都会 401，但 service 状态仍能探活（/health 不要求 token）。

## 9. MV3 worker 状态恢复

### 9.1 worker 重启后 proxy 不卡

`chrome://extensions/` → 该扩展 → "Service Worker" 旁的 **Stop** 按钮，强制 worker 终止。

测试页立刻发：

```js
fetch("https://example.com/api/wake").then(r => r.json()).then(console.log)
```

期望：worker 重新拉起后请求正常返回；不会出现"假离线"导致走原生 fetch（早先版本会因 `runtimeState.health == null` 直接 throw `__RF_SERVICE_OFFLINE__`）。

### 9.2 inflight 跨重启清理

```js
// 起一堆未完成的 fetch
for (let i = 0; i < 5; i++) fetch("https://example.com/api/long-" + i);
```

立刻 Stop service worker。等扩展自动 wake 后，发新的 fetch；老的 5 条对应的 `inflightForwards` 不应在新 worker 里残留——chrome.storage.session 会在 wake 时被清空。

### 9.3 alarms 周期 reconcile

- 编辑某条 asset_redirect 规则，紧接着手动 Stop service worker。
- 不要触发任何 UI 操作，等 1 分钟左右——`chrome.alarms` 会触发 `RECONCILE_ALARM`，自动 wake worker 并把 DNR 同步到最新。
- 验证方式：刷新测试页，资源命中改后规则。

## 10. SSE / 大响应 fall-through

```bash
# 终端 2：mock SSE 上游
node -e "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});setInterval(()=>res.write('data: hi\n\n'),1000)}).listen(9999)"
```

测试页：

```js
const es = new EventSource("https://example.com/api/stream");
es.onmessage = (e) => console.log("sse:", e.data);
setTimeout(() => es.close(), 5000);
```

期望：

- Console 每秒打印 `sse: hi`（流式生效）
- options 命中日志条目 outcome = `passed`（不是 matched 也不是 error）
- service 终端日志能看到 stream-unsupported 409 一次

类似的，`Content-Length: 5242880`（5 MB）以上的二进制响应也走原生。

## 11. 同源 vs 跨域 Cookie

### 11.1 同源默认保留

配规则：path `/api/**`，target `https://example.com`（与 source 同 host）。

```js
document.cookie = "session=abc; path=/";
fetch("https://example.com/api/me");
```

期望：mock 上游收到的请求里有 `cookie: session=abc`。

### 11.2 跨域默认剥离

target 改成 `http://127.0.0.1:9999`。重发 fetch。

期望：mock 上游收到的请求**没有** `cookie` / `origin` / `referer`（保护跨域上游不被同站 cookie 污染）。

### 11.3 强制透传

规则的 Header Policy 把 `cookie` 加进 `passthrough` 列表。再发跨域 fetch。

期望：cookie 透传到上游。

## 12. 敏感 header 加密落盘

配一条 api_forward 规则，自定义头里加 `Authorization: Bearer my-secret-xyz`。保存后：

```bash
cat .resource-forwarder/workspace.json | grep -i 'my-secret-xyz'  # 应无任何输出
cat .resource-forwarder/workspace.json | grep -i 'secret:'        # 看到 secret:<rule-id>:authorization 引用
ls -l .resource-forwarder/secrets.json .resource-forwarder/secret.key  # 应该是 0600 权限
```

期望：

- `workspace.json` 中**不出现**明文 token
- `secrets.json` 是 base64 密文（AES-256-GCM）
- 实际转发时 mock 上游能收到完整的 `Authorization: Bearer my-secret-xyz`（hydrate 透明）

如果删除 `secret.key`，重启 service 后 secrets.json 解密失败，header 变成空字符串——这是预期行为（密钥丢失不可恢复，需要重新填）。

## 出问题怎么定位

| 现象 | 第一步看哪 |
|---|---|
| 转发 404 | service 终端日志 + options 命中日志的 errorMessage |
| 写锁导致 UI 卡顿 | background DevTools Performance；或 `console.time` 包住一次 upsert |
| abort 后内存涨 | Chrome Task Manager 看 service worker memory；或反复跑 4.1 |
| DNR 没生效 | `chrome://extensions` → service worker → console → `await chrome.declarativeNetRequest.getDynamicRules()` 看实际下发的规则 |
| /forward 走错分支 | service 终端临时加 `console.log(rejectReason)` 验证 |
