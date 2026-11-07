# API 参考

[返回 README](../README.md)

导入：零依赖能力（`createRequest` / `fetchAdapter` / 内置拦截器 / 装饰器 / 类型 / 错误）均从主入口 `@huangqi_an/request` 导入；`axiosAdapter`（依赖 axios）与 `uniappAdapter`（依赖全局 `uni`）从 `@huangqi_an/request/adapters/{axios,uniapp}` 子路径导入。`sideEffects: false`，未使用的模块不参与打包。

## 目录

- [createRequest(options)](#createrequestoptions)
- [实例方法](#实例方法)
- [RequestConfig](#requestconfig)
- [RawResponse](#rawresponse)
- [RequestError](#requesterror)
- [拦截器](#拦截器)
- [适配器装饰器](#适配器装饰器)
- [适配器](#适配器)
- [进阶](#进阶)

## createRequest(options)

```ts
import { createRequest } from '@huangqi_an/request'

const http = createRequest({ adapter: fetchAdapter, baseURL: '...' })
```

| 选项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `adapter` | `RequestAdapter` | 是 | 平台适配器，或装饰器组合结果 |
| `baseURL` | `string` | 否 | 相对 url 的前缀；绝对 url 忽略该值 |
| `headers` | `Record<string, string>` | 否 | 实例级默认头，请求级同名覆盖 |
| `timeout` | `number` | 否 | 毫秒；三个适配器中超时均归类为 `kind: 'network'` |

## 实例方法

| 方法 | 说明 |
| --- | --- |
| `request<T>(config)` | 以完整配置发起请求，`method` 接受任意 `RequestMethod` |
| `get<T>(url, config?)` | 快捷方法，`config` 中省略 url/method |
| `post<T>(url, data?, config?)` | 同上，另省略 data |
| `put<T>(url, data?, config?)` | 同上 |
| `patch<T>(url, data?, config?)` | 同上 |
| `delete<T>(url, config?)` | 同上 |
| `interceptors.request.use(fn)` | 注册请求链拦截器 |
| `interceptors.response.use(fn)` | 注册响应链拦截器 |
| `interceptors.error.use(fn)` | 注册错误链拦截器 |

全部请求方法返回 `Promise<RawResponse<T>>`。

快捷方法是 `request()` 的语法糖。需要裁剪方法面（例如禁止使用 DELETE）时，在业务层组合客户端对象：

```ts
// src/api.ts
import { createRequest, fetchAdapter } from '@huangqi_an/request'

const base = createRequest({ adapter: fetchAdapter, baseURL: 'https://api.example.com' })

export const api = {
  get: base.get,
  post: base.post,
  patch: (url: string, data?: unknown) => base.request({ url, data, method: 'PATCH' }),
}
// api 上不存在 put/delete
```

## RequestConfig

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | `string` | 必填；相对 url 与 baseURL 拼接，绝对 url（`http(s)://` 与 `//host`）直接使用 |
| `method` | `RequestMethod` | 默认 `'GET'` |
| `baseURL` | `string` | 请求级覆盖实例级 |
| `params` | `Record<string, unknown>` | query 参数，由 core 序列化（数组生成重复 key、跳过 null/undefined、encodeURIComponent） |
| `data` | `unknown` | 请求体；fetchAdapter 对对象/数组自动 JSON 序列化并补充 `Content-Type` |
| `headers` | `Record<string, string>` | 与实例级浅合并，请求级优先 |
| `timeout` | `number` | 毫秒 |
| `signal` | `AbortSignal` | 取消请求 |
| `on` | `RequestEvents` | 事件订阅，见[事件](#事件) |
| `adapterOptions` | `AdapterOptions` | 平台专有参数透传，见[adapterOptions 透传](#adapteroptions-透传) |

## RawResponse

```ts
interface RawResponse<T = unknown> {
  status: number
  data: T
  headers: Record<string, string>
  durationMs?: number      // core 注入：适配器调用耗时
  config?: RequestConfig   // core 注入：最终请求配置（url 已含 params）
}
```

`durationMs` 与 `config` 由 core 注入，三个适配器形态一致。`res.config.headers` 可读取
requestId 拦截器注入的请求 ID；响应链可根据 `res.config.url` 做条件处理。

## RequestError

| 字段 | 说明 |
| --- | --- |
| `kind` | `'abort' \| 'http' \| 'business' \| 'network'` |
| `status?` | HTTP 状态码（http / business 时存在） |
| `data?` | 响应体或原始响应体 |
| `headers?` | 响应头（http 时存在） |
| `config?` | 最终请求配置 |
| `raw?` | 原始错误：axios 的 `error.code`（如 `ECONNABORTED`）、uni 的 `errMsg` |

| kind | 含义 | 产生来源 |
| --- | --- | --- |
| `http` | 收到响应但状态码非 2xx | core |
| `business` | HTTP 2xx 但业务码失败 | unwrap 拦截器 |
| `abort` | 请求被取消 | 各适配器 |
| `network` | 传输层失败，含超时 | core 包装适配器抛出的错误 |

## 拦截器

### 三条链的语义

```ts
// 请求链：按注册顺序执行，返回新 config
http.interceptors.request.use((config) => ({
  ...config,
  headers: { ...config.headers, Authorization: `Bearer ${getToken()}` },
}))

// 响应链：转换 / 剥壳
http.interceptors.response.use((res) => ({ ...res, data: res.data.data }))

// 错误链：所有失败都会经过
http.interceptors.error.use((err) => {
  report(err) // 无返回值 = 放行
})
```

规则：

1. 三条链相互独立，均按注册顺序执行。
2. 响应链任一环节抛出的错误进入错误链。
3. 进入错误链前，所有失败（请求拦截器抛错 / 网络失败 / 非 2xx / 响应链抛错）均归一化为 `RequestError`。
4. 错误链行为：返回 `RawResponse` 表示恢复（结束错误链，作为最终结果）；返回或抛出 `RequestError` 表示替换当前错误并继续；无返回值表示放行。
5. 恢复发生后不再通知后续错误拦截器。需要覆盖所有错误的上报逻辑应最先注册。

### createAuthInterceptor

请求链：从 `getToken()` 取凭证并注入请求头，支持异步。

```ts
import { createAuthInterceptor } from '@huangqi_an/request'

http.interceptors.request.use(
  createAuthInterceptor({
    getToken: () => getToken(),
    shouldAttach: (config) => !config.url.includes('/login'),
  }),
)
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `getToken` | 必填 | 返回 token（可异步）；返回空值时跳过注入 |
| `headerName` | `'Authorization'` | 注入的头名 |
| `scheme` | `'Bearer '` | token 前缀，不需要时传空字符串 |
| `shouldAttach(config)` | — | 返回 false 的请求不注入 |

### createRequestIdInterceptor

请求链：为每个请求生成唯一 ID 并注入请求头。

```ts
import { createRequestIdInterceptor } from '@huangqi_an/request'

http.interceptors.request.use(createRequestIdInterceptor())
```

- 请求 ID 可从 `RawResponse.config.headers` 与 `RequestError.config.headers` 读取。
- 重试复用同一 config，同一次逻辑请求（含重试）携带相同 ID。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `headerName` | `'X-Request-Id'` | 请求头名 |
| `generateId()` | `crypto.randomUUID()` | 运行时缺失时退化为时间戳加随机数 |
| `keepExisting` | `false` | 请求已携带该头时不覆盖。注意实例级默认头同样视为"已携带" |

### createUnwrapInterceptor

响应链：剥离 `{code, data, message}` 业务壳。业务码失败时抛出 `kind: 'business'` 的
`RequestError`（`data` 为原始响应体），进入错误链。

```ts
import { createUnwrapInterceptor } from '@huangqi_an/request'

http.interceptors.response.use(createUnwrapInterceptor())
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `successCodes` | `[0]` | 业务成功码，允许字符串 |
| `codeKey` / `dataKey` / `messageKey` | `'code' / 'data' / 'message'` | 字段名 |
| — | — | 响应体非对象或缺少业务码字段时原样放行 |

### createLoggerInterceptors

三链日志：返回 `{ request, response, error }`，分别注册到对应链。

```ts
import { createLoggerInterceptors } from '@huangqi_an/request'

const logger = createLoggerInterceptors()
http.interceptors.request.use(logger.request)
http.interceptors.response.use(logger.response)
http.interceptors.error.use(logger.error)
```

- request：method / url / params；response：status / 耗时 / url；error：kind / message / url（warn 级别）。
- 选项 `log(level, ...args)` 可替换为自定义日志实现；该函数不应抛出错误。

## 适配器装饰器

### 组合：use 链

适配器由 `defineAdapter` 创建，可直接使用，也可通过 `.use()` 叠加装饰器。
注册顺序即请求经过顺序：`.use(withDedupe()).use(withRetry())` 中 `withDedupe` 先处理请求。

```ts
import { axiosAdapter } from '@huangqi_an/request/adapters/axios'
import { withRetry } from '@huangqi_an/request'
import { withDedupe } from '@huangqi_an/request'

const adapter = axiosAdapter.use(withDedupe()).use(withRetry({ retries: 2 }))
const http = createRequest({ adapter })
```

`.use` 返回新适配器，原适配器不变；多条链互不影响。

### withRetry

失败自动重试。与错误链恢复不同，重试成功的响应会经过完整管道（含响应链拦截器）。

```ts
import { withRetry } from '@huangqi_an/request'

const adapter = fetchAdapter.use(withRetry({ retries: 2, delayMs: (n) => n * 300 }))
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `retries` | `2` | 最大重试次数（不含首次） |
| `methods` | `['GET', 'HEAD']` | 默认重试规则覆盖的方法 |
| `shouldRetry({error?, response?}, attempt, config)` | — | 提供后完全接管默认规则，`methods` 不再生效 |
| `delayMs(attempt)` | 不等待 | 第 attempt 次重试前的等待毫秒数 |

默认规则：抛出错误且方法在 `methods` 内则重试；非 2xx 响应、取消不重试（取消在任何配置下都不重试）。

### withDedupe

进行中的相同请求共享同一个 Promise，请求结束后自动清理。默认仅对幂等方法生效。

```ts
import { withDedupe } from '@huangqi_an/request'

const adapter = fetchAdapter.use(withDedupe())                               // GET 去重
const antiDoubleSubmit = fetchAdapter.use(withDedupe({ methods: ['POST'] })) // 防止双击重复提交
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `methods` | `['GET', 'HEAD']` | 参与去重的方法；写方法默认不去重 |
| `key(config)` | `` `${method} ${url} ${JSON.stringify(data)}` `` | params 已包含在 url 中；data 无法序列化时该请求不参与去重 |

### 幂等性默认值

两个装饰器默认仅对幂等方法（GET/HEAD）生效：

- 去重的共享语义会减少请求次数。对故意并发的写请求（如计数累加）合并即丢失操作。
- 重试对写方法自动重发，可能重复执行已到达服务端的请求。

因此写方法默认不去重、不重试。需要时显式配置（dedupe 传入 `methods: ['POST']`，retry 提供自定义
`shouldRetry`）。涉及资金的接口应在服务端实现幂等键（Idempotency-Key）。

## 适配器

### 选型

| 适配器 | 依赖 | 适用 |
| --- | --- | --- |
| `fetchAdapter` | 无 | Web / Node.js 18+ / SSR 的默认选择 |
| `axiosAdapter` | axios | 需要 axios 生态时 |
| `uniappAdapter` | 全局 `uni` | uni-app 项目（H5 / 小程序 / App） |
| 自定义 | — | wx 原生小程序、Taro、Electron 等，按契约实现 |

### 能力矩阵

超时与取消在三个适配器中行为一致；平台不支持的进度事件不触发。

| 适配器 | 上传进度 | 下载进度 | 说明 |
| --- | --- | --- | --- |
| `axiosAdapter` | ✓ | ✓ | axios 1.x 浏览器 XHR 与 Node 流式适配器均支持 |
| `uniappAdapter` | ✓ | ✓ | 基于 `task.onProgressUpdate` 归一化；旧基础库缺失该 API 时不触发 |
| `fetchAdapter` | ✗ | ✓ | fetch 无上传进度；下载基于 `res.body` 流式读取，无 `Content-Length` 时 `total/progress` 为 undefined |

`method` 直接透传（`RequestMethod` 含全部动词），但微信小程序受 `wx.request` 方法白名单限制
（OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT，不含 PATCH）。小程序端需要 PATCH 时，
以 POST 加语义路径代替，或通过 `adapterOptions: { uniapp: {...} }` 处理。

### uni-app 平台选择

`uniappAdapter` 依赖 uni-app 全局 `uni.request`。原生微信小程序使用 `wx.request`，
需要单独的适配器（按[自定义适配器](#自定义适配器)契约实现）。uni-app 项目通过条件编译分别创建实例：

```ts
// #ifdef H5
import { fetchAdapter } from '@huangqi_an/request'
export const http = createRequest({ adapter: fetchAdapter })
// #endif
// #ifdef MP-WEIXIN
import { uniappAdapter } from '@huangqi_an/request/adapters/uniapp'
export const http = createRequest({ adapter: uniappAdapter })
// #endif
```

### 自定义适配器

契约共三条：

1. 入参为 `RequestConfig`，其中 `url` 已由 core 完成拼接，是完整地址。
2. 返回 `RawResponse`（`status` / `data` / `headers`），任意状态码都 resolve，状态码判定由 core 负责。
3. 取消时抛出 `name='AbortError'` 的错误；其余错误直接抛出，core 统一包装为 `kind: 'network'`。

`defineAdapter` 将实现函数包装为可链式增强的适配器，并为参数提供类型推断：

```ts
import { createRequest, defineAdapter, withRetry } from '@huangqi_an/request'

const myAdapter = defineAdapter(async (config) => {
  const res = await myTransport.request(config.url, config)
  return { status: res.status, data: res.body, headers: res.headers }
})

const http = createRequest({ adapter: myAdapter.use(withRetry()) })
```

完整示例见 `tests/custom-adapter.test.ts`。

### extend：附加平台方法

适配器可附加平台特有方法（如小程序的 `uploadFile`）。`.extend` 的工厂函数接收组合后的适配器，
附加方法可经过完整管道，并在后续 `.use` 链上保留：

```ts
import { uniappAdapter } from '@huangqi_an/request/adapters/uniapp'
import { withRetry } from '@huangqi_an/request'

const mp = uniappAdapter
  .use(withRetry({ methods: ['GET', 'POST'] }))
  .extend((request) => ({
    upload: (filePath: string, url: string) =>
      new Promise((resolve, reject) => {
        uni.uploadFile({
          url,
          filePath,
          name: 'file',
          success: (res) => resolve({ status: res.statusCode, data: res.data, headers: {} }),
          fail: reject,
        })
      }),
  }))

await mp.post('/x', {})              // 统一方法面不变
await mp.upload('/a.png', uploadUrl) // 平台特有方法，已包含 retry
```

语义：工厂函数在 `extend` 调用时以当前组合执行一次。附加方法需要经过某个装饰器时，
先 `.use` 再 `.extend`；`extend` 之后的 `.use` 不影响已附加的方法。
附加方法不应命名为 `use` / `extend`。

## 进阶

### 统一取消

```ts
const controller = new AbortController()
http.get('/heavy-report', { signal: controller.signal }).catch(() => {})
controller.abort()
```

三个适配器均支持：axios 与 fetch 使用原生取消，uni.request 桥接到 `task.abort()`。

### 事件

事件通过 `config.on` 订阅。进度事件结构为 `{ loaded, total?, progress? }`
（`progress` 为 0-1，`total` 未知时为 undefined）：

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

扩展方式：新增事件（如 `headersReceived`、`chunkReceived`、`retry`）时，扩展 `RequestEvents`
接口并在对应适配器中触发，`RequestConfig` 结构保持不变。

### adapterOptions 透传

平台专有参数通过 `adapterOptions` 传递，按适配器名取用，仅对应适配器读取：

```ts
// 指定 axios 使用的适配器（axios 1.7+）
await http.get('/x', { adapterOptions: { axios: { adapter: 'fetch' } } })

// fetch 携带 cookie、控制缓存
await http.get('/me', { adapterOptions: { fetch: { credentials: 'include', cache: 'no-store' } } })
```

冲突规则：`url / method / headers / timeout / signal / validateStatus` 等契约派生字段
以 `RequestConfig` 为准，透传项无法覆盖。

实例级默认值通过请求拦截器设置：

```ts
http.interceptors.request.use((config) => ({
  ...config,
  adapterOptions: { ...config.adapterOptions, axios: { adapter: 'fetch' } },
}))
```
