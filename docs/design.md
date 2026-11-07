# 工作原理与设计决策

[返回 README](../README.md)

## 请求管道

```
业务代码
  │  http.get('/users')
  ▼
合并默认值（baseURL/headers/timeout）→ 请求链拦截器 → params 写入 url → 取消检查
  ▼
adapter（fetch / axios / uniapp / 自定义）—— 任意状态码均 resolve 为 RawResponse
  ▼
core 判定 2xx ──▶ 响应链拦截器 ──▶ RawResponse ──▶ 业务代码
  │
  └ 非 2xx / 异常 ──▶ 错误链拦截器（可恢复）──▶ 抛出 RequestError ──▶ 业务代码
```

## 插件职责

| 目录 | 内容 | 挂载方式 |
| --- | --- | --- |
| `src/interceptors/` | 三条链上的处理函数（auth / requestId / unwrap / logger） | `http.interceptors.*` |
| `src/enhancers/` | 包装适配器的装饰器（retry / dedupe） | `adapter.use()` |
| `src/adapters/` | 平台发送实现（fetch / axios / uniapp） | `createRequest({ adapter })` |

## 导入路径

| 内容 | 导入来源 |
| --- | --- |
| `createRequest` / `defineAdapter` / 类型 / 错误 / `fetchAdapter` / 内置拦截器 / 装饰器 | `@huangqi_an/request`（零依赖） |
| `axiosAdapter` / `uniappAdapter` | `@huangqi_an/request/adapters/{axios,uniapp}`（分别依赖 axios 与全局 `uni`） |

`package.json` 声明了 `"sideEffects": false`：未被导入的模块（含 axios 依赖）会被 tree-shaking 剔除。

## 设计决策

| 决策 | 原因 |
| --- | --- |
| 平台耦合插件不进入主入口（`sideEffects: false`） | axios / uniapp 适配器必须从子路径导入，axios 不会进入小程序包；零依赖插件从主入口导出 |
| 适配器只返回 `RawResponse`，不做状态码判断 | 各平台对非 2xx 的表现不同（axios 抛错、uni 走 success 回调），统一 resolve 后由 core 判定，保证三端行为一致 |
| params 由 core 拼接 | 三个适配器共用同一序列化规则（数组重复 key、跳过 null/undefined、encodeURIComponent）；`http(s)://` 与协议相对的 `//host` 视为绝对地址，不参与拼接 |
| 取消错误统一为 `name='AbortError'` 的 Error | uni-app 非 H5 运行时无 `DOMException`；`e.name === 'AbortError'` 的判定方式各端通用 |
| dispatch 前检查 `signal.aborted` | 避免在已取消后仍发起请求 |
| 错误独立成链，返回 undefined 表示放行 | 观察类钩子（上报/toast）与恢复、替换使用同一入口，观察类钩子无需重新抛错 |
| 事件使用 `RequestEvents`，`RequestConfig` 结构封闭 | 新增事件只扩展接口并在适配器中触发，配置结构不再变化 |
| `adapterOptions` 透传，契约字段优先 | 平台专有参数有统一入口，且统一语义不可被透传覆盖 |
| retry / dedupe 默认仅作用于幂等方法 | 对写请求不去重、不重试，避免丢失操作或重复执行非幂等操作 |
| 错误包含 `raw` 字段 | 保留 axios 的 `error.code` 与 uni 的 `errMsg`，不丢失排查信息 |

## 开发

```bash
npm install
npm run test       # vitest，89 个用例
npm run typecheck  # tsc --noEmit
npm run build      # tsup，产物输出至 dist/
```

| 测试文件 | 覆盖范围 |
| --- | --- |
| `tests/core.test.ts` | mock 适配器：配置合并、拦截器顺序、params 拼接、错误分类、错误链恢复/替换/放行、快捷方法 |
| `tests/adapter.fetch.test.ts` | 真实 fetch 连接本地 server：响应形状、404、body 序列化、进度（含 chunked）、取消、超时、透传 |
| `tests/adapter.axios.test.ts` | 真实 axios 连接本地 server：响应形状、404、进度、`adapter: 'fetch'` 切换、透传冲突规则 |
| `tests/adapter.uniapp.test.ts` | fake `globalThis.uni`：success/fail 映射、500 透传、取消、进度归一化、透传 |
| `tests/interceptors.test.ts` | auth / requestId / unwrap / logger 全部选项 |
| `tests/enhancers.test.ts` | retry / dedupe 全场景（含幂等默认值）、`.use` 链式语义、`extend` |
| `tests/custom-adapter.test.ts` | 第三方适配器按契约接入 |
