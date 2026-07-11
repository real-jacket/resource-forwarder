import React from "react";
import { ABOUT_REPO_URL } from "../types.js";

/**
 * Static "About" view rendered under the rightmost top-tab.
 *
 * Pure presentation — no props, no state, no hooks. Anything the user can
 * meaningfully click (repo link, issues link) routes through `ABOUT_REPO_URL`
 * which is module-scoped so distributors only edit one constant.
 */
export function AboutView() {
  return (
    <>
      <div className="page-header">
        <div className="page-title">关于</div>
        <div className="page-subtitle">插件信息与使用指南</div>
      </div>

      <div className="about-page">
        <HeroBar />
        <div className="about-guide">
          <FirstRunSection />
          <CoreConceptsSection />
          <WorkflowSection />
          <AssetRedirectExamplesSection />
          <ApiForwardExamplesSection />
          <WildcardReferenceSection />
          <FaqSection />
        </div>
      </div>
    </>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────

function HeroBar() {
  return (
    <div className="about-hero">
      <div className="about-hero-main">
        <div className="about-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <div className="about-hero-text">
          <div className="about-app-kicker">本地开发代理工具</div>
          <div className="about-app-name">Resource Proxy</div>
          <div className="about-app-desc">在浏览器网络层替换资源，在页面请求层转发、修改或模拟 API 响应。</div>
        </div>
      </div>
      <div className="about-hero-links">
        {ABOUT_REPO_URL && (
          <a className="about-hero-link" href={ABOUT_REPO_URL} target="_blank" rel="noopener noreferrer">
            源码<ExternalLinkIcon />
          </a>
        )}
        {ABOUT_REPO_URL && (
          <a className="about-hero-link" href={`${ABOUT_REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">
            反馈<ExternalLinkIcon />
          </a>
        )}
      </div>
      <div className="about-hero-overview" aria-label="核心能力">
        <div className="about-overview-item is-asset">
          <strong>资源替换</strong>
          <span>Chrome DNR 网络层重定向</span>
        </div>
        <div className="about-overview-item is-forward">
          <strong>API 转发</strong>
          <span>fetch / XHR 请求改写</span>
        </div>
        <div className="about-overview-item is-mock">
          <strong>响应模拟</strong>
          <span>内联 JSON 或本地文件</span>
        </div>
      </div>
    </div>
  );
}

function FirstRunSection() {
  return (
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">可选 Companion 配置</span>
        <span className="acc-badge">本地能力</span>
      </summary>
      <div className="about-accordion-body">
        <p>普通 API 转发、响应修改和内联 JSON Mock 直接由浏览器执行。只有本地文件、受限 Header 或强制本地执行规则需要 Companion 与 token。</p>
        <ol className="about-setup-steps">
          <li>启动服务（<code>pnpm dev</code> 或 <code>pnpm dev:service</code>）。控制台会打印类似：<br />
            <code>[forwarder-service] auth token file: /Users/&lt;you&gt;/.../.resource-forwarder/token</code>
          </li>
          <li>把该文件的内容（一行 UUID）整段复制。</li>
          <li>在「设置 → 通用设置」里的「服务 token」输入框粘贴并保存。</li>
        </ol>
        <div className="guide-tip">
          <strong>排查：</strong>如果设置页提示「服务 token 校验失败」，表示 token 不对。重启服务后会保留同一个 token，没必要每次重新粘贴；只有 <code>~/.resource-forwarder/token</code> 文件被删后才会重新生成。
        </div>
        <div className="guide-warn">
          <strong>安全：</strong>该 token 是本地服务的唯一鉴权凭证。任何拿到 token + 本机网络可达的进程都能调用 <code>/forward</code>，请勿粘贴到任何远程脚本或截图。
        </div>
      </div>
    </details>
  );
}

function CoreConceptsSection() {
  return (
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">核心概念</span>
        <span className="acc-badge">快速了解</span>
      </summary>
      <div className="about-accordion-body">
        <p>插件支持两种规则类型：</p>
        <table className="guide-table">
          <thead><tr><th>类型</th><th>适用场景</th><th>工作原理</th></tr></thead>
          <tbody>
            <tr><td><code>资源替换</code></td><td>JS、CSS、图片、字体等静态资源</td><td>Chrome DNR 网络层直接重定向，支持通配符</td></tr>
            <tr><td><code>API 转发</code></td><td>fetch / XHR 接口请求</td><td>拦截请求 → Background 安全重匹配 → 浏览器或 Companion 执行</td></tr>
          </tbody>
        </table>
        <div className="guide-tip">
          <strong>如何选择？</strong> 浏览器直接加载的资源（<code>&lt;script&gt;</code>、<code>&lt;link&gt;</code>、<code>&lt;img&gt;</code>）选<strong>资源替换</strong>；JS 代码发起的 <code>fetch</code> / <code>XHR</code> 请求选<strong>API 转发</strong>。
        </div>
        <h3>匹配链路</h3>
        <p>每条规则按以下层级依次判断，所有层级都通过才会执行：</p>
        <ol className="about-match-steps">
          <li><strong>站点页面范围</strong>：当前页面必须属于规则所属站点。</li>
          <li><strong>分组页面范围</strong>：分组可进一步缩小页面范围，未配置时继承站点。</li>
          <li><strong>规则请求条件</strong>：再检查 Host、路径、Query、Header、方法和资源类型。</li>
          <li><strong>优先级</strong>：多条规则都通过时，优先级更高的规则先命中。</li>
        </ol>
        <div className="guide-warn">
          <strong>归属要求：</strong>规则必须唯一归属于一个分组，分组必须归属于有效站点。未归组、重复归组或找不到站点的配置会保留供修复，但不会参与代理。
        </div>
        <h3>路径匹配语法 (pathGlob)</h3>
        <table className="guide-table">
          <thead><tr><th>通配符</th><th>含义</th><th>示例</th></tr></thead>
          <tbody>
            <tr><td><code>*</code></td><td>匹配单层任意字符（不跨 <code>/</code>）</td><td><code>/assets/*.js</code> ✓ <code>app.js</code>　✗ <code>js/app.js</code></td></tr>
            <tr><td><code>**</code></td><td>匹配任意层级路径（跨 <code>/</code>）</td><td><code>/api/**</code> ✓ <code>users</code>　✓ <code>v2/users/list</code></td></tr>
          </tbody>
        </table>
        <h3>站点匹配 vs 规则 Host</h3>
        <table className="guide-table">
          <thead><tr><th></th><th>作用</th><th>示例</th></tr></thead>
          <tbody>
            <tr><td><strong>站点匹配</strong></td><td>控制<strong>在哪些页面上</strong>生效（页面 URL 匹配时才激活规则）</td><td><code>https://shimo.im/tables/*</code></td></tr>
            <tr><td><strong>规则级 Host</strong></td><td>控制<strong>拦截哪个域名</strong>的请求（请求目标域名）</td><td><code>as.smgv.cn</code></td></tr>
          </tbody>
        </table>
        <div className="guide-warn">
          <strong>注意：</strong>站点匹配的是<strong>当前页面的 URL</strong>，规则 Host 匹配的是<strong>请求目标的域名</strong>。例如：页面在 <code>shimo.im</code>，JS 来自 CDN <code>as.smgv.cn</code>，则站点匹配填 <code>https://shimo.im/*</code>，规则 Host 填 <code>as.smgv.cn</code>。
        </div>
      </div>
    </details>
  );
}

function WorkflowSection() {
  return (
    <details className="about-accordion" open>
      <summary>
        <ChevronIcon />
        <span className="acc-title">工作流程</span>
        <span className="acc-badge">架构全景</span>
      </summary>
      <div className="about-accordion-body">
        <p>先从系统边界理解各模块如何协作，再沿一次请求查看规则如何决策，最后对照两条实际执行链路。</p>
        <SystemArchitectureDiagram />
        <RequestExecutionDiagram />
        <AssetRedirectFlow />
        <ApiForwardFlow />
        <div className="guide-tip">
          <strong>关键区别：</strong>资源替换在 Chrome 网络层生效，能拦截所有类型请求（包括 <code>&lt;script&gt;</code>、<code>&lt;link&gt;</code> 标签）；API 转发在 JS 层生效，只能拦截 <code>fetch</code> / <code>XMLHttpRequest</code>。
        </div>
      </div>
    </details>
  );
}

function AssetRedirectExamplesSection() {
  return (
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">资源替换示例</span>
        <span className="acc-badge">6 个场景</span>
      </summary>
      <div className="about-accordion-body">
        <h3>1. 精确替换单个文件</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-asset">资源替换</span>精确匹配</>}
          rows={[
            ["Host", "co-dev-18.shimorelease.com"],
            ["路径匹配", "/minio/shimo-assets/table/grid-view.chunk.js"],
            ["重定向 URL", "http://localhost:8000/grid-view.chunk.js"],
          ]}
          note="请求精确匹配到该路径时，直接重定向到本地文件。"
        />

        <h3>2. 通配符替换一批文件（常用）</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-asset">资源替换</span>通配符 - 批量 chunk</>}
          rows={[
            ["Host", "co-dev-18.shimorelease.com"],
            ["路径匹配", "/minio/shimo-assets/table/*.chunk.js"],
            ["重定向 URL", "http://localhost:8000/*.chunk.js"],
          ]}
          note={<><code>*</code> 在路径匹配和重定向 URL 中一一对应。请求 <code>p20.chunk.js</code> → 重定向到 <code>http://localhost:8000/p20.chunk.js</code>。</>}
        />

        <h3>3. 带 hash 的资源文件</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-asset">资源替换</span>hash 文件名</>}
          rows={[
            ["路径匹配", "/minio/shimo-assets/table/zebra.*.js"],
            ["重定向 URL", "http://localhost:8000/zebra.js"],
          ]}
          note="重定向 URL 无通配符，所有匹配都指向同一个本地文件。适合 hash 每次构建变化的场景。"
        />

        <h3>4. 替换 CSS 文件</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-asset">资源替换</span>样式文件</>}
          rows={[
            ["路径匹配", "/minio/shimo-assets/table/main.*.css"],
            ["重定向 URL", "http://localhost:8000/main.css"],
            ["资源类型", "stylesheet"],
          ]}
        />

        <h3>5. 替换整个目录（** 通配）</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-asset">资源替换</span>目录级通配</>}
          rows={[
            ["路径匹配", "/static/js/**"],
            ["重定向 URL", "http://localhost:3000/static/js/**"],
          ]}
          note={<><code>**</code> 匹配任意层级子路径。</>}
        />

        <h3>6. 跨 CDN 域名替换</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-asset">资源替换</span>CDN → 本地</>}
          rows={[
            ["Host", "as.smgv.cn"],
            ["路径匹配", "/table/zebra.*.js"],
            ["重定向 URL", "http://localhost:8000/zebra.js"],
          ]}
          note="CDN 资源也支持替换。Host 填写 CDN 域名即可。"
        />
      </div>
    </details>
  );
}

function ApiForwardExamplesSection() {
  return (
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">API 转发示例</span>
        <span className="acc-badge">7 个场景</span>
      </summary>
      <div className="about-accordion-body">
        <h3>1. 将接口转发到本机后端</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>基础转发</>}
          rows={[
            ["Host", "app.example.com"],
            ["路径匹配", "/api/**"],
            ["目标地址", "http://localhost:3000"],
            ["请求方法", "GET, POST, PUT, DELETE"],
          ]}
          note={<><code>/api/users/list</code> → <code>http://localhost:3000/api/users/list</code>，路径完整保留。</>}
        />

        <h3>2. 转发并去除路径前缀 (stripPrefix)</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>去除前缀</>}
          rows={[
            ["路径匹配", "/gateway/user-service/**"],
            ["目标地址", "http://localhost:4000"],
            ["去除前缀", "/gateway/user-service"],
          ]}
          note={<><code>/gateway/user-service/profile</code> → <code>http://localhost:4000/profile</code></>}
        />

        <h3>3. 转发到不同端口的微服务</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>微服务拆分</>}
          rows={[
            ["规则 A", "/api/auth/** → http://localhost:4001"],
            ["规则 B", "/api/files/** → http://localhost:4002"],
            ["规则 C", "/api/collab/** → http://localhost:4003"],
          ]}
          note="按路径前缀分别转发到各自的本地端口。"
        />

        <h3>4. 注入自定义请求头</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>自定义 Headers</>}
          rows={[
            ["路径匹配", "/api/internal/**"],
            ["目标地址", "http://localhost:3000"],
            ["自定义头", `{"X-Debug": "true", "X-User-Id": "test-123"}`],
          ]}
          note="转发时自动附加额外 Header，方便调试权限、灰度等逻辑。"
        />

        <h3>5. 修改真实接口的 JSON 响应</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>响应合并覆盖</>}
          rows={[
            ["响应来源", "请求上游并返回"],
            ["JSON 合并覆盖", `{"data":{"name":"本地调试用户","role":null},"debug":true}`],
          ]}
          note={<>对象字段会递归合并到上游 JSON；值为 <code>null</code> 的字段会从最终响应中删除。</>}
        />

        <h3>6. 直接返回内联 JSON</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>内联 Mock</>}
          rows={[
            ["响应来源", "直接返回内联 JSON"],
            ["状态码", "404"],
            ["返回 JSON", `{"code":"USER_NOT_FOUND","data":null}`],
          ]}
          note="命中后不会请求目标地址，适合快速联调空态、异常态和权限态。"
        />

        <h3>7. 用本地 JSON 文件替代响应</h3>
        <ExampleBlock
          badge={<><span className="example-badge badge-api">API 转发</span>文件 Mock</>}
          rows={[
            ["响应来源", "返回本地 JSON 文件"],
            ["文件路径", "./mocks/user-detail.json"],
            ["延迟", "800 ms"],
          ]}
          note="相对路径以本地转发服务的启动目录为基准；只接受不超过 4 MiB 的 .json 文件。"
        />
      </div>
    </details>
  );
}

function WildcardReferenceSection() {
  return (
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">通配符重定向对照表</span>
        <span className="acc-badge">参考</span>
      </summary>
      <div className="about-accordion-body">
        <p>资源替换的重定向 URL 中的 <code>*</code> / <code>**</code> 与路径匹配中的通配符一一对应：</p>
        <table className="guide-table">
          <thead><tr><th>线上请求 URL</th><th>路径匹配</th><th>重定向 URL</th><th>实际结果</th></tr></thead>
          <tbody>
            <tr><td><code>.../table/p20.chunk.js</code></td><td><code>/.../table/*.chunk.js</code></td><td><code>http://localhost:8000/*.chunk.js</code></td><td><code>http://localhost:8000/p20.chunk.js</code></td></tr>
            <tr><td><code>.../table/grid.chunk.js</code></td><td><code>/.../table/*.chunk.js</code></td><td><code>http://localhost:8000/*.chunk.js</code></td><td><code>http://localhost:8000/grid.chunk.js</code></td></tr>
            <tr><td><code>.../table/zebra.a1b2c3.js</code></td><td><code>/.../table/zebra.*.js</code></td><td><code>http://localhost:8000/zebra.js</code></td><td><code>http://localhost:8000/zebra.js</code></td></tr>
            <tr><td><code>.../js/vendor/react.js</code></td><td><code>/static/js/**</code></td><td><code>http://localhost:3000/static/js/**</code></td><td><code>http://localhost:3000/static/js/vendor/react.js</code></td></tr>
          </tbody>
        </table>
        <div className="guide-tip">
          <strong>规律：</strong>重定向 URL 中不含通配符 → 所有匹配指向同一个固定地址；包含通配符 → 匹配内容原样填入对应位置。
        </div>
      </div>
    </details>
  );
}

function FaqSection() {
  return (
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">常见问题</span>
        <span className="acc-badge">FAQ</span>
      </summary>
      <div className="about-accordion-body">
        <h3>资源替换和 API 转发应该怎么选？</h3>
        <p>
          浏览器通过 <code>&lt;script&gt;</code>、<code>&lt;link&gt;</code>、<code>&lt;img&gt;</code> 标签加载的资源只能用<strong>资源替换</strong>。JS 代码中 <code>fetch()</code> 或 <code>XMLHttpRequest</code> 发起的请求两种都行，但需要转发请求体或注入 Header 时选<strong>API 转发</strong>。
        </p>

        <h3>为什么我的资源规则不生效（404）？</h3>
        <ul>
          <li>检查规则类型：<code>.chunk.js</code> 等脚本文件必须用<strong>资源替换</strong></li>
          <li>检查 Host：规则的 Host 必须与资源实际域名一致（CDN 域名可能与页面域名不同）</li>
          <li>检查路径匹配：在 DevTools Network 面板复制资源完整 URL 路径对照</li>
          <li>检查资源目标对应的本地开发服务器是否启动：确认 <code>localhost:端口</code> 可正常访问</li>
        </ul>

        <h3>如何调试 webpack 的动态 chunk？</h3>
        <p>使用通配符规则：路径匹配 <code>/assets/table/*.chunk.js</code>，重定向 URL <code>http://localhost:8000/*.chunk.js</code>。所有 chunk 文件自动映射到本地。</p>

        <h3>优先级怎么设置？</h3>
        <p>数字越大优先级越高。建议：精确匹配 100、通配符 50、兜底 <code>/**</code> 设 10。</p>

        <h3>从 Resource Override 导入的规则</h3>
        <p>导入时自动识别：localhost 静态资源 → <strong>资源替换</strong>，API 路径 → <strong>API 转发</strong>。导入后可在规则列表查看和调整。</p>

        <h3>SSE / 大文件下载为什么没被代理？</h3>
        <p>
          浏览器执行器与 Companion 共用的转发核心会检查响应：<code>Content-Type: text/event-stream</code>（SSE）或 <code>Content-Length</code> 超过 4 MiB 时
          默认放行到原生 fetch / XHR（命中日志中显示 <code>passed</code>）。如果规则选择了<strong>代理失败时直接报错</strong>，则不会回源。
          这是有意为之。若把它们整块缓冲到 base64 再回传，会破坏 <code>EventSource</code> / <code>ReadableStream</code> 的流式语义，并可能撑爆扩展消息通道。
        </p>

        <h3>为什么建议写接口关闭“无法代理时回源”？</h3>
        <p>
          默认回源能保证所选执行器不可用、SSE 或大请求/响应无法通过消息通道时页面继续工作，但也可能把写请求重新发到共享测试或线上地址。
          对会修改数据的接口，建议在规则高级设置中选择<strong>直接报错，不回源</strong>。
        </p>

        <h3>如何修改接口响应，或完全不请求上游？</h3>
        <p>
          在规则高级设置的<strong>响应行为</strong>中选择：<strong>请求上游并返回</strong>可用 JSON 合并覆盖修改真实响应；
          <strong>直接返回内联 JSON</strong>适合快速构造状态；<strong>返回本地 JSON 文件</strong>适合维护较大的 Mock 数据。
          三种模式都能覆盖状态码、状态描述、响应 Header，并添加最多 30 秒延迟。
        </p>

        <h3>转发请求里的 Cookie 何时会保留？</h3>
        <p>
          目标地址 <strong>同 host</strong>（例如 <code>app.example.com</code> → <code>https://app.example.com</code>）时，扩展会自动读取当前请求域的 Cookie 并补到转发请求中，方便保持会话。
          <strong>跨域</strong>转发时（例如转到 <code>localhost</code>）默认不带 Cookie。需要强制跨域带 Cookie，请在高级设置的“强制透传 Header”中加入 <code>cookie</code>；扩展会通过 Chrome cookies 权限读取当前请求域的 Cookie（包括 HttpOnly）再转发。
        </p>

        <h3>Authorization 等敏感头会以明文存盘吗？</h3>
        <p>
          不会。规则的 <code>headers</code> 中 <code>authorization</code>、<code>cookie</code>、<code>x-api-key</code> 等敏感字段在落盘时会被 AES-256-GCM 加密到 <code>secrets.json</code>（0600），<code>workspace.json</code> 中只剩 <code>secret:&lt;id&gt;</code> 引用。导出工作区时仍是明文，方便迁移；不需要时请勿把导出文件放到不受信任的位置。
        </p>

        <h3>升级到 0.x 后，部分规则路径不再命中？</h3>
        <p>
          这一版统一了 <code>pathGlob</code> 的语义：<strong>单个 <code>*</code> 不再跨 <code>/</code></strong>。如果你之前依赖 <code>/api/*</code> 同时匹配 <code>/api/users/42</code>，请改成 <code>/api/**</code>。
        </p>

        <h3>sidepanel 显示「未匹配」时，为什么资源还被替换？</h3>
        <p>
          asset_redirect 规则注册到 Chrome DNR 时会绑定到项目的 <code>siteHosts</code>（<code>initiatorDomains</code>）：
          原则上只有项目站点页面发起的请求才能被替换。如果 sidepanel hero 区显示
          <strong>橙色</strong>的「N 条 DNR 已注册」徽章，说明 Chrome 中仍注册着 N 条规则。
          通常是 workspace 视角下当前页面已不匹配，或 DNR 还未随 workspace 变更同步清理。
          在 background DevTools 跑 <code>await chrome.declarativeNetRequest.getDynamicRules()</code>
          可查看真实下发的规则集；扩展会在下次 commitWorkspace 或 <code>chrome.alarms</code> 周期（约 1 分钟）
          触发时自动重新 reconcile。例外：把项目 <code>siteHosts</code> 设为 <code>*</code> 的真 global 项目
          不绑 initiator，会对任何页面发起的命中请求生效。
        </p>
      </div>
    </details>
  );
}

// ── Flow diagrams (used by WorkflowSection) ──────────────────────────

function SystemArchitectureDiagram() {
  return (
    <section className="system-diagram" aria-labelledby="system-architecture-title">
      <div className="system-diagram-heading">
        <div>
          <h3 id="system-architecture-title">项目结构全景</h3>
          <p>五个 workspace package 共享类型、匹配与转发核心；扩展默认直接执行，Companion 只补充本地能力。</p>
        </div>
        <div className="system-diagram-legend" aria-label="图例">
          <span><i className="legend-swatch is-browser" />浏览器</span>
          <span><i className="legend-swatch is-core" />核心逻辑</span>
          <span><i className="legend-swatch is-service" />可选 Companion</span>
        </div>
      </div>

      <div className="architecture-map">
        <ArchitectureLayer
          tone="interface"
          eyebrow="配置与观察"
          title="用户界面"
          description="编辑工作区、查看状态与快速开关规则"
          nodes={[
            { title: "Options Page", detail: "完整 CRUD / 导入导出" },
            { title: "Side Panel", detail: "状态、命中与快捷开关" },
          ]}
        />
        <ArchitectureConnector label="runtime message" detail="配置提交 / 状态同步" />
        <ArchitectureLayer
          tone="browser"
          eyebrow="extension-shell"
          title="扩展运行层"
          description="Background 负责安全重匹配与执行能力路由"
          nodes={[
            { title: "Background Worker", detail: "workspace / capability router / logs" },
            { title: "Browser Executor", detail: "API 转发 / 响应改写 / 内联 Mock" },
            { title: "Content + Page Bridge", detail: "注入并拦截 fetch / XHR" },
            { title: "Chrome DNR", detail: "网络层资源重定向" },
          ]}
        />
        <ArchitectureConnector label="shared contracts" detail="统一数据结构与匹配语义" />
        <ArchitectureLayer
          tone="core"
          eyebrow="共享能力"
          title="核心逻辑层"
          description="跨浏览器与 Node 复用的 TypeScript 深模块"
          nodes={[
            { title: "shared-types", detail: "工作区 / 规则 / 运行时协议" },
            { title: "rule-core", detail: "匹配、排序、校验、DNR 转换" },
            { title: "forward-core", detail: "请求改写、上游 fetch、响应策略" },
          ]}
        />
        <ArchitectureConnector label="按能力选择" detail="仅本地专属规则走 HTTP /forward" />
        <ArchitectureLayer
          tone="service"
          eyebrow="forwarder-service"
          title="可选 Companion 层"
          description="为浏览器无法安全完成的本地能力提供适配器"
          nodes={[
            { title: "Local Adapter", detail: "任意文件路径 / 受限 Header" },
            { title: "workspace.json", detail: "工作区快照" },
            { title: "logs/*.jsonl", detail: "每日命中日志" },
          ]}
        />
      </div>

      <div className="architecture-boundary">
        <div className="architecture-boundary-title">外部运行边界</div>
        <div className="architecture-boundary-nodes">
          <span>当前网页</span>
          <span>Chrome 网络栈</span>
          <span>上游 API</span>
          <span>本地开发服务</span>
          <span>本地 JSON Mock</span>
        </div>
      </div>

      <div className="architecture-dependency">
        <strong>代码依赖方向</strong>
        <code>shared-types</code><span>→</span><code>rule-core</code><span>→</span><code>forward-core</code><span>→</span><code>extension-shell / forwarder-service</code>
      </div>
    </section>
  );
}

function ArchitectureLayer({
  tone,
  eyebrow,
  title,
  description,
  nodes,
}: {
  tone: "interface" | "browser" | "core" | "service";
  eyebrow: string;
  title: string;
  description: string;
  nodes: Array<{ title: string; detail: string }>;
}) {
  return (
    <div className={`architecture-layer is-${tone}`}>
      <div className="architecture-layer-eyebrow">{eyebrow}</div>
      <div className="architecture-layer-title">{title}</div>
      <div className="architecture-layer-description">{description}</div>
      <div className="architecture-layer-nodes">
        {nodes.map((node) => (
          <div className="architecture-node" key={node.title}>
            <strong>{node.title}</strong>
            <span>{node.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArchitectureConnector({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="architecture-connector" aria-hidden="true">
      <span className="architecture-connector-label">{label}</span>
      <span className="architecture-connector-line">→</span>
      <span className="architecture-connector-detail">{detail}</span>
    </div>
  );
}

function RequestExecutionDiagram() {
  return (
    <section className="system-diagram execution-diagram" aria-labelledby="request-execution-title">
      <div className="system-diagram-heading">
        <div>
          <h3 id="request-execution-title">一次请求如何被处理</h3>
          <p>只有全部作用域与请求条件都通过，规则才有资格进入执行链路。</p>
        </div>
        <span className="execution-order">高优先级优先，结果唯一</span>
      </div>

      <div className="execution-filter-chain">
        <ExecutionStep title="页面发起请求" detail="资源加载或 fetch / XHR" tone="source" />
        <ExecutionArrow label="当前页面" />
        <ExecutionStep title="站点范围" detail="Project pageScope" tone="scope" />
        <ExecutionArrow label="AND" />
        <ExecutionStep title="分组范围" detail="RuleSet pageScope" tone="scope" />
        <ExecutionArrow label="AND" />
        <ExecutionStep title="请求条件" detail="Host / Path / Query / Header / Method / Type" tone="match" />
        <ExecutionArrow label="全部通过" />
        <ExecutionStep title="选出唯一规则" detail="priority ↓ / createdAt ↑ / id ↑" tone="winner" />
      </div>

      <div className="execution-split-label"><span>按规则类型进入不同执行层</span></div>

      <div className="execution-branches">
        <div className="execution-branch is-asset">
          <div className="execution-branch-heading">
            <span className="flow-tag flow-tag-asset">asset_redirect</span>
            <strong>资源替换</strong>
          </div>
          <div className="execution-branch-flow">
            <ExecutionMiniStep title="rule-core" detail="转换为 DNR" />
            <span>→</span>
            <ExecutionMiniStep title="Chrome DNR" detail="网络层匹配" />
            <span>→</span>
            <ExecutionMiniStep title="本地资源" detail="直接重定向" />
          </div>
          <p>适用于 script、stylesheet、image、font 等浏览器直接加载的资源。</p>
        </div>

        <div className="execution-branch is-api">
          <div className="execution-branch-heading">
            <span className="flow-tag flow-tag-api">api_forward</span>
            <strong>API 转发与响应替换</strong>
          </div>
          <div className="execution-api-path">
            <span>Page Bridge</span><b>→</b><span>Content Script</span><b>→</b><span>Background 重匹配</span><b>→</b><span>Browser / Companion</span>
          </div>
          <div className="response-mode-grid">
            <div><strong>真实转发</strong><span>请求上游，可应用 JSON Merge Patch</span></div>
            <div><strong>内联 JSON</strong><span>不请求上游，直接构造响应</span></div>
            <div><strong>本地 JSON 文件</strong><span>读取指定 .json 作为响应</span></div>
          </div>
          <div className="execution-response-tail">统一应用状态码、状态描述、响应 Header 与延迟，再返回 fetch / XHR 调用方</div>
        </div>
      </div>

      <div className="execution-fallback">
        <strong>异常与不可缓冲响应</strong>
        <span>所选执行器不可用、请求体或响应超限、SSE 无法缓冲时：</span>
        <code>fallbackMode=native</code><span>回到原始请求</span>
        <code>fallbackMode=error</code><span>向页面返回错误</span>
      </div>
    </section>
  );
}

function ExecutionStep({ title, detail, tone }: { title: string; detail: string; tone: "source" | "scope" | "match" | "winner" }) {
  return (
    <div className={`execution-step is-${tone}`}>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function ExecutionArrow({ label }: { label: string }) {
  return (
    <div className="execution-arrow" aria-hidden="true">
      <span>{label}</span>
      <b>→</b>
    </div>
  );
}

function ExecutionMiniStep({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="execution-mini-step">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function FlowArrowRight({ label }: { label?: string }) {
  return (
    <div className="flow-arrow">
      <div className="flow-arrow-line">
        <svg viewBox="0 0 32 12" aria-hidden="true">
          <line x1="0" y1="6" x2="26" y2="6" stroke="currentColor" strokeWidth="1.5" />
          <polygon points="26,2 32,6 26,10" fill="currentColor" />
        </svg>
      </div>
      {label && <div className="flow-arrow-text">{label}</div>}
    </div>
  );
}

function AssetRedirectFlow() {
  return (
    <div className="flow-container">
      <div className="flow-container-title">
        <span className="flow-tag flow-tag-asset">资源替换</span>
        asset_redirect 链路
      </div>
      <div className="flow-diagram">
        <div className="flow-row">
          <FlowNode kind="ext" label="规则注册" text="match.host" sub="写入 requestDomains" />
          <FlowArrowRight />
          <FlowNode kind="ext" label="规则注册" text="pathGlob" sub="写入 urlFilter / regexFilter" />
          <FlowArrowRight label="注册到" />
          <FlowNode kind="chrome" label="Chrome" text="DNR 规则" sub="绑 initiatorDomains，按项目站点作用域生效" />
        </div>
        <div style={{ height: 10 }} />
        <div className="flow-row">
          <FlowNode kind="browser" label="浏览器" text="发起请求" sub="<script> / <link> / <img>" />
          <FlowArrowRight />
          <FlowNode kind="chrome" label="Chrome 网络层" text="发起页过滤" sub="initiatorDomains 限定项目页面" />
          <FlowArrowRight label="页面命中" />
          <FlowNode kind="chrome" label="Chrome 网络层" text="目标 + 路径匹配" sub="requestDomains + urlFilter" />
          <FlowArrowRight label="全部命中" />
          <FlowNode kind="ext" label="重定向" text="替换 URL" sub="redirect / regexSub" />
          <FlowArrowRight />
          <FlowNode kind="target" label="目标" text="localhost" sub="本地开发服务" />
        </div>
      </div>
      <p className="flow-description">
        规则的 <code>match.host</code> 和 <code>pathGlob</code> 在注册时转为 Chrome DNR 条件，
        同时把项目的 <code>siteHosts</code> 写入 <code>initiatorDomains</code>。浏览器每次请求都会经过 Chrome 网络层，依次检查
        <strong>发起页面</strong>（initiatorDomains，限定为项目站点）→
        <strong>目标域名</strong>（requestDomains）→
        <strong>路径</strong>（urlFilter / regexFilter）→
        <strong>资源类型</strong>（script / stylesheet / image / font），
        全部通过才执行重定向。
      </p>
      <p className="flow-description is-secondary">
        例外：当项目的 <code>siteHosts</code> 为空或包含 <code>*</code>（真 global 项目）时不绑 initiatorDomains，会对任何页面发起的命中请求生效。
      </p>
    </div>
  );
}

function ApiForwardFlow() {
  return (
    <div className="flow-container">
      <div className="flow-container-title">
        <span className="flow-tag flow-tag-api">API 转发</span>
        api_forward 链路
      </div>
      <div className="flow-diagram">
        <div className="flow-row">
          <FlowNode kind="page" label="进入页面时" text="按 Host 筛选" sub="trimWorkspaceForUrl" />
          <FlowArrowRight label="下发规则" />
          <FlowNode kind="page" label="Page Bridge" text="patch fetch/XHR" sub="只注入匹配的规则" />
        </div>
        <div style={{ height: 10 }} />
        <div className="flow-row">
          <FlowNode kind="browser" label="页面 JS" text="fetch / XHR" sub="发起接口请求" />
          <FlowArrowRight label="拦截" />
          <FlowNode kind="page" label="Page Bridge" text="完整请求匹配" sub="Host / Path / Method / Header..." />
          <FlowArrowRight label="命中规则" />
          <FlowNode kind="ext" label="Content Script" text="消息中转" sub="→ Background" />
          <FlowArrowRight label="runtime" />
          <FlowNode kind="ext" label="Background" text="安全重匹配" sub="能力路由" />
          <FlowArrowRight />
          <FlowNode kind="target" label="执行器" text="浏览器 / Companion" sub="普通规则优先浏览器" />
        </div>
      </div>
      <p className="flow-description">
        进入页面时，Background 先按当前页面的 Host 筛选出相关规则，只下发匹配的规则给 Page Bridge。
        随后 Page Bridge 对每个 <code>fetch</code> / <code>XHR</code> 请求检查 Host、路径、Query、Header、方法和资源类型，并按稳定优先级选出唯一规则。
        Background 不信任页面传入的规则提示，会重新验证规则是否仍启用且完整匹配。普通转发、JSON Merge Patch 与内联 Mock 直接由浏览器执行；任意本地文件路径和受限 Header 在自动模式下交给 Companion。
        <strong>注意：</strong>此链路无法拦截 <code>&lt;script&gt;</code> 等浏览器直接加载的资源。
      </p>
    </div>
  );
}

function FlowNode({
  kind,
  label,
  text,
  sub,
}: {
  kind: "ext" | "chrome" | "browser" | "target" | "page" | "service";
  label: string;
  text: string;
  sub: string;
}) {
  return (
    <div className={`flow-node node-${kind}`}>
      <div className="flow-node-label">{label}</div>
      <div className="flow-node-text">{text}</div>
      <div className="flow-node-sub">{sub}</div>
    </div>
  );
}

// ── Reusable inline icon helpers ─────────────────────────────────────

function ChevronIcon() {
  return (
    <svg className="acc-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function ExampleBlock({
  badge,
  rows,
  note,
}: {
  badge: React.ReactNode;
  rows: Array<[label: string, value: React.ReactNode]>;
  note?: React.ReactNode;
}) {
  return (
    <div className="guide-example-block">
      <div className="guide-example-label">{badge}</div>
      <div className="guide-example-rows">
        {rows.map(([label, value], i) => (
          <div className="guide-example-row" key={`${label}-${i}`}>
            <span className="guide-field">{label}</span>
            <span className="guide-value">{value}</span>
          </div>
        ))}
      </div>
      {note && <div className="guide-note">{note}</div>}
    </div>
  );
}
