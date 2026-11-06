# request

统一请求层：一份业务代码，axios / fetch / uni-app 三端通用，也欢迎任何自定义通道。

- **零依赖核心**：`src/index.ts` 不带任何平台依赖；适配器、拦截器、装饰器都是按需导入的插件，不被 import 的模块不进 bundle
- **统一语义**：状态码判断、错误四分类、取消、超时、进度、拦截器——三端行为完全一致
- **可扩展**：自定义适配器只需一个函数契约；事件（`RequestEvents`）与平台专有参数（`adapterOptions`）都有封闭的扩展点

> 适用形态：npm 包（`@huangqi_an/request`）或源码直引（拷贝 `src/`），零构建。
> 本文档描述当前实现，`npm run test` 的 86 个用例即文档行为快照。

## 目录

- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [API 参考](#api-参考)
  - [createRequest(options)](#createrequestoptions) / [实例方法](#实例方法) / [RequestConfig](#requestconfig) / [RawResponse](#rawresponse) / [RequestError](#requesterror)
- [拦截器](#拦截器)
  - [三条链的语义](#三条链的语义) / [createAuthInterceptor](#createauthinterceptor) / [createRequestIdInterceptor](#createrequestidinterceptor) / [createUnwrapInterceptor](#createunwrapinterceptor) / [createLoggerInterceptors](#createloggerinterceptors)
- [适配器装饰器](#适配器装饰器)
  - [组合：use 链](#组合use-链) / [withRetry](#withretry) / [withDedupe](#withdedupe) / [幂等性默认](#幂等性默认)
- [适配器](#适配器)
  - [选型](#选型) / [能力矩阵](#能力矩阵) / [uni-app 平台选择](#uni-app-平台选择) / [自定义适配器](#自定义适配器)
- [进阶](#进阶)
  - [统一取消](#统一取消) / [事件](#事件) / [adapterOptions 透传](#adapteroptions-透传)
- [设计决策](#设计决策)
- [开发](#开发)

## 快速开始

### 1. 安装

**npm（推荐）**：

```bash
npm install @huangqi_an/request
# 仅使用 axiosAdapter 时需要自备 axios（optional peer dependency）：
npm install axios
```

**源码直引**：把 `src/` 拷进项目（或作为 monorepo 共享包引入），零构建；
本文示例中的 `@huangqi_an/request/...` 换成相对路径（如 `./src`）即可。

### 2. 创建实例并发请求（Web / Node / SSR）

```ts
import { createRequest } from './src'
import { fetchAdapter } from './src/adapters/fetch'

export const http = createRequest({
  adapter: fetchAdapter,                 // 零依赖；Node 18+ / 现代浏览器
  baseURL: 'https://api.example.com',
  timeout: 15000,
  headers: { 'X-Client': 'web' },
})

// 发请求
const res = await http.get('/users', { params: { page: 1 } })
res.data       // 响应体（JSON 自动解析，视 adapter 而定）
res.status     // 200
res.headers    // Record<string, string>
res.durationMs // 耗时（core 注入）
```

### 3. uni-app

```ts
import { createRequest } from './src'
import { uniappAdapter } from './src/adapters/uniapp'

export const http = createRequest({
  adapter: uniappAdapter,               // 基于 uni.request，H5 / 小程序 / App 通用
  baseURL: 'https://api.example.com',
})
```

### 4. 统一错误处理

所有失败最终抛出同一个 `RequestError`，按 `kind` 四分类：

```ts
import { RequestError } from './src'

try {
  await http.post('/orders', { sku: 1 })
} catch (err) {
  if (err instanceof RequestError) {
    switch (err.kind) {
      case 'http':      // 非 2xx：err.status / err.data / err.headers
        break
      case 'business':  // HTTP 2xx 但业务码失败（unwrap 拦截器产生）：err.data 为原始 body
        break
      case 'abort':     // 请求被取消
        break
      case 'network':   // 传输层失败（含超时）：err.raw 保留原始错误可排查
        break
    }
  }
}
```

## 工作原理

```
业务代码
  │  http.get('/users')
  ▼
合并默认值（baseURL/headers/timeout）→ 请求链拦截器 → params 拼进 url → 取消检查
  ▼
adapter（fetch / axios / uniapp / 自定义）——任何状态码都 resolve 成 RawResponse
  ▼
core 判 2xx ──▶ 响应链拦截器（剥壳/转换）──▶ RawResponse ──▶ 业务代码
  │
  └ 非 2xx / 异常 ──▶ 错误链拦截器（可恢复）──▶ 抛 RequestError ──▶ 业务代码
```

三类插件各司其职：

| 插件目录 | 是什么 | 挂在哪 |
| --- | --- | --- |
| `src/interceptors/` | 三条链上的处理函数（auth / requestId / unwrap / logger） | `http.interceptors.*` |
| `src/enhancers/` | 包装 adapter 的装饰器（retry / dedupe） | `adapter.use()` |
| `src/adapters/` | 平台发送实现（fetch / axios / uniapp） | `createRequest({ adapter })` |

导入路径一览（门面 `src/index.ts` 只含契约，插件一律按需导入）：

| 需要什么 | 从哪导入 |
| --- | --- |
| `createRequest` / `defineAdapter` / 类型 / 错误 | `./src`（零依赖，任何端） |
| 适配器 | `./src/adapters/{fetch,axios,uniapp}` |
| 内置拦截器 | `./src/interceptors/{auth,request-id,unwrap,logger}` |
| 装饰器 | `./src/enhancers/{retry,dedupe}` |

## API 参考

### createRequest(options)

```ts
import { createRequest } from './src'

const http = createRequest({ adapter: fetchAdapter, baseURL: '...' })
```

| 选项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `adapter` | `RequestAdapter` | ✓ | 平台适配器，或装饰器组合结果（`axiosAdapter.use(...)`） |
| `baseURL` | `string` | — | 相对 url 的前缀；绝对 url 自动忽略 |
| `headers` | `Record<string, string>` | — | 实例级默认头，请求级同名覆盖 |
| `timeout` | `number` | — | 毫秒；三端统一归类为 `kind: 'network'` |

### 实例方法

| 方法 | 说明 |
| --- | --- |
| `request<T>(config)` | 全量配置发请求，`method` 接受任意 `RequestMethod`（含 PATCH 等）——这是唯一必需的入口 |
| `get<T>(url, config?)` | 快捷方法，`config` 中省略 url/method |
| `post<T>(url, data?, config?)` | 同上，省略 url/method/data |
| `put<T>(url, data?, config?)` | 同上 |
| `patch<T>(url, data?, config?)` | 同上 |
| `delete<T>(url, config?)` | 同上 |
| `http.interceptors.request.use(fn)` | 注册请求链拦截器 |
| `http.interceptors.response.use(fn)` | 注册响应链拦截器（成功转换） |
| `http.interceptors.error.use(fn)` | 注册错误链拦截器 |

全部请求方法返回 `Promise<RawResponse<T>>`。

快捷方法只是 `request()` 的语法糖，你不调用就没有任何成本。需要**裁剪方法面**（如团队规范禁用
DELETE）或自定义动词时，在业务层组合自己的 client 对象——库保持完整能力，导出面由你决定：

```ts
// src/api.ts —— 团队实际消费的入口
import { createRequest } from './src'
import { fetchAdapter } from './src/adapters/fetch'

const base = createRequest({ adapter: fetchAdapter, baseURL: 'https://api.example.com' })

export const api = {
  get: base.get,
  post: base.post,
  patch: (url: string, data?: unknown) => base.request({ url, data, method: 'PATCH' }),
}
// 没有 put/delete：业务方拿不到，core 的任何语义不受影响
```

### RequestConfig

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | `string` | 必填；相对 url 拼 baseURL，绝对 url 直接使用 |
| `method` | `RequestMethod` | 默认 `'GET'` |
| `baseURL` | `string` | 请求级覆盖实例级 |
| `params` | `Record<string, unknown>` | query 参数，core 统一序列化（数组重复 key、跳过 null/undefined、encodeURIComponent） |
| `data` | `unknown` | 请求体；fetch 端对象/数组自动 JSON 序列化并补 `Content-Type` |
| `headers` | `Record<string, string>` | 与实例级浅合并，请求级优先 |
| `timeout` | `number` | 毫秒 |
| `signal` | `AbortSignal` | 统一取消（见[统一取消](#统一取消)） |
| `on` | `RequestEvents` | 事件订阅（见[事件](#事件)） |
| `adapterOptions` | `AdapterOptions` | 平台专有参数透传（见[adapterOptions 透传](#adapteroptions-透传)） |

### RawResponse

```ts
interface RawResponse<T = unknown> {
  status: number              // HTTP 状态码
  data: T                     // 响应体
  headers: Record<string, string>
  durationMs?: number         // core 注入：adapter 调用耗时
  config?: RequestConfig      // core 注入：最终请求配置（url 已拼好 params）
}
```

`durationMs` / `config` 由 core 统一注入，三端形态一致；`res.config.headers` 可取到
requestId 拦截器注入的请求 ID（报障定位），响应链也可按 url 做条件逻辑。

### RequestError

| 字段 | 说明 |
| --- | --- |
| `kind` | `'abort' \| 'http' \| 'business' \| 'network'`，见下表 |
| `status?` | HTTP 状态码（http / business 时存在） |
| `data?` | 响应体或原始 body |
| `headers?` | 响应头（http 时） |
| `config?` | 最终请求配置（可取请求 ID 等注入头） |
| `raw?` | 原始错误：axios 的 `error.code`（如 `ECONNABORTED` 超时）、uni 的 `errMsg` |

| kind | 含义 | 来源 |
| --- | --- | --- |
| `http` | 收到响应但状态码非 2xx | core |
| `business` | HTTP 2xx 但业务码失败 | unwrap 拦截器 |
| `abort` | 请求被取消（AbortSignal / 平台取消） | 各适配器 |
| `network` | 传输层失败，含超时 | core 包装适配器抛错 |

## 拦截器

### 三条链的语义

```ts
// 请求链：按注册顺序执行，返回新 config（注入 token / 请求 ID 等）
http.interceptors.request.use((config) => ({
  ...config,
  headers: { ...config.headers, Authorization: `Bearer ${getToken()}` },
}))

// 响应链（成功）：转换 / 剥壳
http.interceptors.response.use((res) => ({ ...res, data: res.data.data }))

// 错误链：所有失败都会经过（可恢复 / 可替换 / 可观察）
http.interceptors.error.use((err) => {
  report(err)                                            // 无返回值 = 放行
})
```

规则：

1. 三条链相互独立，均**按注册顺序**执行
2. 响应链任一环节抛错，进入错误链
3. 错误链入口先归一化：所有失败（请求拦截器抛错 / 网络失败 / 非 2xx / 响应链抛错）都是 `RequestError`
4. 错误链行为：**返回 `RawResponse` = 恢复**（结束错误链，直接作为最终结果）；**返回/抛出 `RequestError` = 替换**当前错误继续走链；**无返回值 = 放行**（纯观察）
5. 要"所有错误都上报"，上报拦截器必须**最先注册**——恢复发生后就不再通知后续拦截器

### createAuthInterceptor

请求链：从 `getToken()` 注入凭证头，支持异步（如先静默刷新）。

```ts
import { createAuthInterceptor } from './src/interceptors'

http.interceptors.request.use(
  createAuthInterceptor({
    getToken: () => getToken(),
    shouldAttach: (config) => !config.url.includes('/login'),
  }),
)
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `getToken` | 必传 | 返回 token（可异步）；返回空值则跳过注入 |
| `headerName` | `'Authorization'` | 注入的头名 |
| `scheme` | `'Bearer '` | token 前缀；不需要传空字符串 |
| `shouldAttach(config)` | — | 返回 false 的请求不注入 |

### createRequestIdInterceptor

请求链：每个请求生成唯一 ID 注入请求头，用于前后端日志关联与报障定位。

```ts
import { createRequestIdInterceptor } from './src/interceptors'

http.interceptors.request.use(createRequestIdInterceptor())
```

- core 会把最终 config 盖章到 `RawResponse.config` 与 `RequestError.config`，响应日志、错误上报都能取到同一个 ID
- 重试共享同一 config：同一次逻辑请求（含重试）带同一个 ID，服务端可识别重发

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `headerName` | `'X-Request-Id'` | 请求头名 |
| `generateId()` | `crypto.randomUUID()` | 运行时缺失时退化为时间戳+随机数；可接入 tracing/Sentry 等链路库 |
| `keepExisting` | `false` | 已带该头时不覆盖（上游链路透传）。注意：实例级默认头也算"已携带"，开启会导致所有请求共用一个 ID，慎用 |

### createUnwrapInterceptor

响应链：剥离 `{code, data, message}` 业务壳；业务码失败抛 `kind: 'business'` 的 `RequestError`（`data` 为原始 body，进入错误链）。

```ts
import { createUnwrapInterceptor } from './src/interceptors'

http.interceptors.response.use(createUnwrapInterceptor())
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `successCodes` | `[0]` | 业务成功码，允许字符串码 |
| `codeKey` / `dataKey` / `messageKey` | `'code' / 'data' / 'message'` | 字段名 |
| — | — | body 非对象或缺业务码字段时原样放行（防御非 JSON 响应） |

### createLoggerInterceptors

三链日志：返回 `{ request, response, error }` 三件套，分别注册。

```ts
import { createLoggerInterceptors } from './src/interceptors'

const logger = createLoggerInterceptors()   // 默认 console
http.interceptors.request.use(logger.request)
http.interceptors.response.use(logger.response)
http.interceptors.error.use(logger.error)
```

- request：method / url / params；response：status / 耗时 / url；error：kind / message / url（warn 级别）
- 选项 `log(level, ...args)` 可替换为埋点 SDK；注入的函数**不应抛错**

## 适配器装饰器

### 组合：use 链

适配器经 `defineAdapter` 导出，本身可直接用，也可 `.use()` 叠加装饰器。
**注册顺序 = 请求流经顺序**（与拦截器链一致）：`.use(withDedupe()).use(withRetry())`
从上往下读就是请求经过的顺序——先去重（合并并发），再去重窗口内重试。

```ts
import { axiosAdapter } from './src/adapters/axios'
import { withRetry } from './src/enhancers/retry'
import { withDedupe } from './src/enhancers/dedupe'

const adapter = axiosAdapter.use(withDedupe()).use(withRetry({ retries: 2 }))
const http = createRequest({ adapter })
```

`.use` 返回新适配器、不修改原对象，分支链互不影响。

### withRetry

失败自动重试。与错误链恢复不同：重试成功的响应会正常走完整管道（响应链剥壳等）。

```ts
import { withRetry } from './src/enhancers/retry'

const adapter = fetchAdapter.use(withRetry({ retries: 2, delayMs: (n) => n * 300 }))
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `retries` | `2` | 最大重试次数（不含首次；总尝试 = 1 + retries） |
| `methods` | `['GET', 'HEAD']` | 默认重试规则覆盖的方法 |
| `shouldRetry({error?, response?}, attempt, config)` | — | 提供后**完全接管**默认规则（`methods` 不再生效） |
| `delayMs(attempt)` | 不等待 | 第 attempt 次重试前的等待毫秒 |

默认规则：抛错且方法幂等 → 重试；非 2xx 响应、取消 → 不重试（取消无论配置如何都不重试）。

### withDedupe

进行中的相同请求共享同一个 Promise（settle 后自动清理）。默认只对幂等方法生效。

```ts
import { withDedupe } from './src/enhancers/dedupe'

const adapter = fetchAdapter.use(withDedupe())                          // GET 去重
const antiDoubleSubmit = fetchAdapter.use(withDedupe({ methods: ['POST'] })) // 防双击
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `methods` | `['GET', 'HEAD']` | 参与去重的方法；写方法默认放行 |
| `key(config)` | `` `${method} ${url} ${JSON.stringify(data)}` `` | params 已拼进 url；data 无法序列化时该请求不参与去重（宁可漏，不可错合并） |

### 幂等性默认

两个装饰器都只对幂等方法（GET/HEAD）默认生效——

- dedupe 的 share 语义不会"多发"，但会"少发"：对故意并发的写请求（如计数 +1）静默合并等于丢操作
- retry 对写方法自动重发，可能重复执行已到达服务端的请求（如重复扣款）

所以写方法默认放行 / 不重试；需要时显式 opt-in（dedupe 传 `methods: ['POST']` 做防双击、retry 提供自定义 `shouldRetry`）。资金类接口请以后端幂等键（Idempotency-Key）兜底，前端只是第一道闸。

## 适配器

### 选型

| 适配器 | 依赖 | 适用 |
| --- | --- | --- |
| `fetchAdapter` | 无 | Web / Node 18+ / SSR 的默认选择 |
| `axiosAdapter` | axios | 需要 axios 生态（拦截器插件、老浏览器兼容、`adapterOptions.axios.adapter` 切换传输）时 |
| `uniappAdapter` | 全局 `uni` | uni-app 项目（H5 / 小程序 / App） |
| 自定义 | — | wx 原生小程序、Taro、Electron net……按契约接入（见下） |

### 能力矩阵

平台差异在适配器内抹平，做不到的静默不触发；超时与取消三端行为一致。

| 适配器 | 上传进度 | 下载进度 | 说明 |
| --- | --- | --- | --- |
| `axiosAdapter` | ✓ | ✓ | axios 1.x 浏览器 XHR 与 Node 流式适配器均支持 |
| `uniappAdapter` | ✓ | ✓ | `task.onProgressUpdate` 归一化（旧基础库缺失该 API 时跳过） |
| `fetchAdapter` | ✗ | ✓ | fetch 无上传进度（平台限制）；下载走 `res.body` 流式读取，`Content-Length` 缺失时 `total/progress` 为 undefined |

> HTTP 动词备注：`method` 直接透传（`RequestMethod` 含全动词），但微信小程序端受 `wx.request`
> 方法白名单限制（仅 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT，**不含 PATCH**）——
> mp 端需要 PATCH 时用 POST + 语义路径代替，或经 `adapterOptions: { uniapp: {...} }` 定制。

### uni-app 平台选择

注意：**uni-app ≠ 原生微信小程序**。本库的 `uniappAdapter` 依赖 uni-app 全局 `uni.request`；
原生小程序用的是 `wx.request`，那是另一套 API，需要单独的适配器（按契约实现即可，见下）。
uni-app 项目用条件编译分别创建实例（导入路径按你放置 `src/` 的位置调整）：

```ts
// #ifdef H5
import { fetchAdapter } from '@/request/adapters/fetch'
export const http = createRequest({ adapter: fetchAdapter })
// #endif
// #ifdef MP-WEIXIN
import { uniappAdapter } from '@/request/adapters/uniapp'
export const http = createRequest({ adapter: uniappAdapter })
// #endif
```

### 自定义适配器

契约只有三句话：

1. 输入 `RequestConfig`——其中的 `url` 已由 core 拼好 params，是完整地址
2. 返回 `RawResponse`（`status` / `data` / `headers`），**任何状态码都 resolve，判断交给 core**
3. 取消时抛 `name='AbortError'` 的错误，其余错误随意抛（core 统一包装为 `kind: 'network'`，`raw` 保留原始错误）

`defineAdapter` 把实现函数包装为可链式增强的适配器（参数获得类型推断）：

```ts
import { createRequest, defineAdapter } from './src'

const myAdapter = defineAdapter(async (config) => {
  const res = await myTransport.request(config.url, config)
  return { status: res.status, data: res.body, headers: res.headers }
})

const http = createRequest({ adapter: myAdapter.use(withRetry()) })
```

可运行的完整示例见 `tests/custom-adapter.test.ts`（一个与内置 `adapters/fetch.ts` 同构的 fetch 实现）。

## 进阶

### 统一取消

所有适配器都走标准 `AbortSignal`：

```ts
const controller = new AbortController()
http.get('/heavy-report', { signal: controller.signal }).catch(() => {})
controller.abort() // axios：原生取消；uni.request：桥接到 task.abort()；fetch：原生取消
```

### 事件

事件通过 `config.on` 订阅，进度事件统一为 `{ loaded, total?, progress? }`（`progress` 为 0-1，`total` 未知时为 undefined）：

```ts
await http.post('/upload', formData, {
  on: {
    uploadProgress: ({ progress }) => bar.update(progress),
  },
})
await http.get('/big-file', {
  on: {
    downloadProgress: ({ loaded, total }) => console.log(loaded, total),
  },
})
```

**扩展策略**：`on` 是事件的唯一入口——以后新增事件（如 `headersReceived`、`chunkReceived`、`retry`）
只扩展 `RequestEvents` 接口并在对应适配器中 emit，`RequestConfig` 结构保持封闭。

### adapterOptions 透传

平台特有参数不进 `RequestConfig` 根，统一走 `adapterOptions`（按适配器名取用、仅对应适配器消费）：

```ts
// 让 axios 走它自己的 fetch 适配器（axios 1.7+）
await http.get('/x', { adapterOptions: { axios: { adapter: 'fetch' } } })

// fetch 携带 cookie / 控制缓存
await http.get('/me', { adapterOptions: { fetch: { credentials: 'include', cache: 'no-store' } } })
```

冲突规则：`url / method / headers / timeout / signal / validateStatus` 等契约派生字段始终以
`RequestConfig` 为准，透传项覆盖不了它们——统一语义不被破坏。

实例级默认透传用请求拦截器即可，不需要额外 API：

```ts
http.interceptors.request.use((config) => ({
  ...config,
  adapterOptions: { ...config.adapterOptions, axios: { adapter: 'fetch' } },
}))
```

## 设计决策

| 决策 | 原因 |
| --- | --- |
| 主入口零依赖，插件按需导入 | 依赖各自携带，未被 import 的模块不进 bundle；小程序包体积与平台耦合由结构保证，而非约定 |
| 适配器只返回 `RawResponse`，不做任何判断 | 404/500 在两端表现不同（axios 抛错、uni 走 success），统一 resolve 交给 core 判 2xx，是三端语义归一的支点 |
| params 在 core 拼成完整 URL | 三端行为完全一致（数组重复 key、跳过 null/undefined、encode 规则），适配器保持"哑" |
| 取消统一为 `name='AbortError'` 的 Error | uni-app 非 H5 运行时（小程序/App 端）没有 `DOMException`；`e.name === 'AbortError'` 的判定方式各端兼容 |
| core dispatch 前先查 `signal.aborted` | 防止"已取消还发请求"的竞态 |
| 错误独立成链，undefined 即放行 | 观察（上报/toast）与恢复/替换同一入口；观察类钩子不必被迫 rethrow |
| 事件走 `RequestEvents`，`RequestConfig` 结构封闭 | 新增事件只扩接口并在适配器 emit，契约不再膨胀 |
| `adapterOptions` 逃生舱，契约字段优先 | 平台特有参数有统一去处，且统一语义（状态码/取消/超时）不可被透传破坏 |
| retry / dedupe 默认仅幂等方法 | 写请求宁可放行（不去重、不重试），绝不静默吞操作或重发非幂等操作 |
| 错误带 `raw` 字段 | 保留 axios 的 `error.code`（如 `ECONNABORTED` 超时）和 uni 的 `errMsg`，排查不丢信息 |

## 开发

```bash
npm install
npm run test       # vitest，86 个用例
npm run typecheck  # tsc --noEmit
```

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/core.test.ts` | mock 适配器：配置合并、拦截器顺序、params 拼接、错误四分类、错误链恢复/替换/放行 |
| `tests/adapter.fetch.test.ts` | 真实 fetch 打本地 server：形状、404、body 序列化、进度（含 chunked）、取消、超时、透传 |
| `tests/adapter.axios.test.ts` | 真实 axios 打本地 server：形状、404、进度、`adapter: 'fetch'` 切换、透传冲突规则 |
| `tests/adapter.uniapp.test.ts` | fake `globalThis.uni`：success/fail 映射、500 透传、取消、进度归一化、透传 |
| `tests/interceptors.test.ts` | auth / unwrap / logger / requestId 全选项覆盖 |
| `tests/enhancers.test.ts` | retry/dedupe 全场景（含幂等默认）+ `.use` 链式语义 |
| `tests/custom-adapter.test.ts` | 第三方按契约接入的可行性证明 |
