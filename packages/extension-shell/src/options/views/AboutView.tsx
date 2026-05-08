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
      <div className="about-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      </div>
      <div className="about-hero-text">
        <div className="about-app-name">Resource Proxy</div>
        <div className="about-app-desc">本地资源代理插件，高效调试、预览与协作</div>
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
    </div>
  );
}

function CoreConceptsSection() {
  return (
    <details className="about-accordion" open>
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
            <tr><td><code>API 转发</code></td><td>fetch / XHR 接口请求</td><td>拦截请求 → 本地服务转发 → 返回响应</td></tr>
          </tbody>
        </table>
        <div className="guide-tip">
          <strong>如何选择？</strong> 浏览器直接加载的资源（<code>&lt;script&gt;</code>、<code>&lt;link&gt;</code>、<code>&lt;img&gt;</code>）选<strong>资源替换</strong>；JS 代码发起的 <code>fetch</code> / <code>XHR</code> 请求选<strong>API 转发</strong>。
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
    <details className="about-accordion">
      <summary>
        <ChevronIcon />
        <span className="acc-title">工作流程</span>
        <span className="acc-badge">流程图</span>
      </summary>
      <div className="about-accordion-body">
        <p>插件通过两条不同链路拦截和转发请求。</p>
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
          badge={<><span className="example-badge badge-asset">资源替换</span>通配符 — 批量 chunk</>}
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
        <span className="acc-badge">4 个场景</span>
      </summary>
      <div className="about-accordion-body">
        <h3>1. 将接口转发到本地服务</h3>
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
          <li>检查本地服务是否启动：确认 <code>localhost:端口</code> 可正常访问</li>
        </ul>

        <h3>如何调试 webpack 的动态 chunk？</h3>
        <p>使用通配符规则：路径匹配 <code>/assets/table/*.chunk.js</code>，重定向 URL <code>http://localhost:8000/*.chunk.js</code>。所有 chunk 文件自动映射到本地。</p>

        <h3>优先级怎么设置？</h3>
        <p>数字越大优先级越高。建议：精确匹配 100、通配符 50、兜底 <code>/**</code> 设 10。</p>

        <h3>从 Resource Override 导入的规则</h3>
        <p>导入时自动识别：localhost 静态资源 → <strong>资源替换</strong>，API 路径 → <strong>API 转发</strong>。导入后可在规则列表查看和调整。</p>
      </div>
    </details>
  );
}

// ── Flow diagrams (used by WorkflowSection) ──────────────────────────

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
          <FlowNode kind="chrome" label="Chrome" text="DNR 规则" sub="全局生效，跨标签页" />
        </div>
        <div style={{ height: 10 }} />
        <div className="flow-row">
          <FlowNode kind="browser" label="浏览器" text="发起请求" sub="<script> / <link> / <img>" />
          <FlowArrowRight />
          <FlowNode kind="chrome" label="Chrome 网络层" text="Host 匹配" sub="requestDomains 过滤" />
          <FlowArrowRight label="域名命中" />
          <FlowNode kind="chrome" label="Chrome 网络层" text="路径 + 类型匹配" sub="urlFilter + resourceTypes" />
          <FlowArrowRight label="全部命中" />
          <FlowNode kind="ext" label="重定向" text="替换 URL" sub="redirect / regexSub" />
          <FlowArrowRight />
          <FlowNode kind="target" label="目标" text="localhost" sub="本地开发服务" />
        </div>
      </div>
      <p className="about-guide" style={{ margin: 0, fontSize: 12 }}>
        规则的 <code>match.host</code> 和 <code>pathGlob</code> 在注册时转为 Chrome DNR 条件，全局生效。
        浏览器每次请求都会经过 Chrome 网络层，依次检查 <strong>域名</strong>（requestDomains）→
        <strong>路径</strong>（urlFilter / regexFilter）→ <strong>资源类型</strong>（script / stylesheet / image / font），
        全部通过才执行重定向。
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
          <FlowNode kind="page" label="Page Bridge" text="Host + 路径匹配" sub="matchesHost + matchesPath" />
          <FlowArrowRight label="命中规则" />
          <FlowNode kind="ext" label="Content Script" text="消息中转" sub="→ Background" />
          <FlowArrowRight label="runtime" />
          <FlowNode kind="service" label="本地服务" text="/forward" sub="stripPrefix + 转发" />
          <FlowArrowRight />
          <FlowNode kind="target" label="目标" text="上游服务" sub="localhost:端口" />
        </div>
      </div>
      <p className="about-guide" style={{ margin: 0, fontSize: 12 }}>
        进入页面时，Background 先按当前页面的 Host 筛选出相关规则，只下发匹配的规则给 Page Bridge。
        随后 Page Bridge 对每个 <code>fetch</code> / <code>XHR</code> 请求再做一次 <code>matchesHost</code> + 路径匹配。
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
