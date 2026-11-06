# request

统一请求层：一份业务代码，Web 端跑 axios 或零依赖 fetch、uni-app 端跑 uni.request，也欢迎任何自定义通道（Taro、Electron net……）。

核心形态是**插件式**的：主入口零依赖，内置 adapter 是 `src/adapters/` 下按需导入的模块，
自定义 adapter 只需满足一个函数契约。

不做 axios 自定义 adapter，也不让 uni.request 假装 axios——adapter 只负责
"发请求 → 返回原始结果 → 翻译取消语义"，配置合并、params 拼接、状态码判断、
错误归一化、拦截器全部收进共享 core。

```
src/
├── index.ts        # 零依赖门面：types / errors / core，不含 adapter 与内置拦截器
├── types.ts        # RequestConfig / RawResponse / RequestAdapter / 拦截器类型（纯类型）
├── errors.ts       # RequestError（abort | http | business | network 四分类）+ createAbortError
├── core.ts         # createRequest / defineAdapter / buildUrl
├── interceptors/   # 内置拦截器（零依赖纯函数工厂，按需导入）
│   ├── auth.ts     # Token 注入（请求链）
│   ├── request-id.ts # 请求 ID 注入（请求链）
│   ├── unwrap.ts   # 业务壳剥离（响应链）
│   └── logger.ts   # 三链日志
├── enhancers/      # adapter 装饰器（不发请求，只包装 adapter，按需导入）
│   ├── retry.ts    # withRetry：失败自动重试
│   └── dedupe.ts   # withDedupe：进行中请求共享
└── adapters/       # 平台 adapter 插件（真正发请求的那层），一律按需导入
    ├── fetch.ts    # 全局 fetch（Web/Node/SSR，零依赖）
    ├── axios.ts       # axios（Web 端，需要 axios 生态时用）
    └── uniapp.ts   # uni.request（uni-app 端：H5 / 小程序 / App 通用）
```

> 以下示例的导入路径以本仓库布局为准（`./src`）；把 `src/` 放进你的项目后，按你的目录调整前缀即可。

## 用法

### 1. 主入口（零依赖，任何端都可导入）

```ts
import { createRequest, defineAdapter } from './src'
```

### 2. 选择一个 adapter（按需导入）

Web 端二选一：默认用零依赖的 `fetchAdapter`；需要 axios 生态（成熟拦截器插件、上传进度事件、老旧浏览器兼容）时用 `axiosAdapter`。uni-app 项目用 `uniappAdapter`。

```ts
// Web/Node/SSR：零依赖 fetch（Node 18+ / 现代浏览器）
import { fetchAdapter } from './src/adapters/fetch'
import { createRequest } from './src'

const http = createRequest({
  adapter: fetchAdapter,
  baseURL: 'https://api.example.com',
  timeout: 15000,
  headers: { 'X-Client': 'web' },
})
```

```ts
// Web 端：adapter 插件自带 axios 依赖
import { axiosAdapter } from './src/adapters/axios'
import { createRequest } from './src'

const http = createRequest({
  adapter: axiosAdapter,
  baseURL: 'https://api.example.com',
  timeout: 15000,
  headers: { 'X-Client': 'web' },
})
```

```ts
// uni-app 端
import { createRequest } from './src/core'
import { uniappAdapter } from './src/adapters/uniapp'

const http = createRequest({ adapter: uniappAdapter, baseURL: 'https://api.example.com' })
```

未被 import 的 adapter 模块不会进 bundle——解耦靠模块结构，不靠注释自觉。
平台选择属于应用层：纯 Web 直接用 `axiosAdapter`；uni-app 用条件编译分别创建实例
（路径按你放置 `src/` 的位置调整）：

```ts
// #ifdef H5
import { axiosAdapter } from '@/request/adapters/axios'
export const http = createRequest({ adapter: axiosAdapter })
// #endif
// #ifdef MP-WEIXIN
import { uniappAdapter } from '@/request/adapters/uniapp'
export const http = createRequest({ adapter: uniappAdapter })
// #endif
```

> 注意区分：**uni-app ≠ 原生微信小程序**。上面的 adapter 依赖的是 uni-app 全局 `uni.request`；
> 原生小程序用的是 `wx.request`，那是另一套全局 API，需要单独的 adapter——按"自定义 adapter"
> 的契约实现即可接入，不必改动 core。

### 3. 自定义 adapter

契约只有三句话：

1. 输入 `RequestConfig`——其中的 `url` 已由 core 拼好 params，是完整地址；
2. 返回 `RawResponse`（`status` / `data` / `headers`），**任何状态码都 resolve，判断交给 core**；
3. 取消时抛 `name='AbortError'` 的错误，其余错误随意抛（core 统一包装为 `kind: 'network'`，`raw` 保留原始错误）。

下面这个例子与内置的 `adapters/fetch.ts` 同构（第三方通道照此约 40 行接入），
`defineAdapter` 把实现函数包装为**可链式增强的 adapter**（参数获得类型推断）：
返回值可直接传给 `createRequest`，也可以 `.use()` 叠加装饰器：

```ts
// 例如 Node/SSR 场景的 fetch adapter，不需要 axios
import { createRequest, defineAdapter } from './src'

const fetchAdapter = defineAdapter(async (config) => {
  const res = await fetch(config.url, {
    method: config.method ?? 'GET',
    headers: config.headers,
    body: config.data != null ? JSON.stringify(config.data) : undefined,
    signal: config.signal,
  })
  return { status: res.status, data: await res.json(), headers: Object.fromEntries(res.headers.entries()) }
})

const http = createRequest({ adapter: fetchAdapter })
```

（可运行的完整版本见 `tests/custom-adapter.test.ts`。）

### 4. 内置拦截器与 adapter 装饰器

同样是插件：零依赖、按需导入，不用的不进 bundle。

```ts
import { createRequest } from './src'
import { axiosAdapter } from './src/adapters/axios'
import { withRetry } from './src/enhancers/retry'
import { withDedupe } from './src/enhancers/dedupe'
import {
  createAuthInterceptor,
  createRequestIdInterceptor,
  createUnwrapInterceptor,
  createLoggerInterceptors,
} from './src/interceptors'

const http = createRequest({
  // .use：从上到下 = 请求流经顺序 —— 先去重（合并并发），再去重窗口内重试；
  // 重试/去重发生在 adapter 层，重试成功的响应正常走完整管道（响应链剥壳等）
  adapter: axiosAdapter.use(withDedupe()).use(withRetry({ retries: 2 })),
  baseURL: 'https://api.example.com',
})

// 请求链：注入 token（支持异步、跳过登录接口）
http.interceptors.request.use(
  createAuthInterceptor({
    getToken: () => getToken(),
    shouldAttach: (config) => !config.url.includes('/login'),
  }),
)

// 请求链：每个请求注入唯一 ID，前后端日志关联、报障定位
//（重试共享同一 ID；错误链可从 err.config.headers 取到）
http.interceptors.request.use(createRequestIdInterceptor())

// 响应链：剥离 {code, data, message} 业务壳；业务码失败抛 kind='business'
http.interceptors.response.use(createUnwrapInterceptor())

// 三链日志：请求 / 响应（含耗时）/ 错误
const logger = createLoggerInterceptors()
http.interceptors.request.use(logger.request)
http.interceptors.response.use(logger.response)
http.interceptors.error.use(logger.error)
```

为什么 retry/dedupe 不是错误拦截器？错误链的恢复结果不回响应链（恢复即最终结果），
若在错误链里重试，重试成功后不会再剥壳。adapter 装饰器在管道更上游循环，语义最干净。

> **幂等性默认**：两个装饰器都只对幂等方法（GET/HEAD）默认生效。
> - dedupe 的 share 语义不会"多发"，但会"少发"——对故意并发的写请求（如计数 +1）静默合并等于丢操作；
> - retry 对写方法自动重发，可能重复执行已到达服务端的请求（如重复扣款）。
>
> 所以写方法默认放行 / 不重试；需要时显式 opt-in（dedupe 传 `methods: ['POST']` 做防双击、
> retry 提供自定义 `shouldRetry`）。资金类接口请以后端幂等键（Idempotency-Key）兜底，前端只是第一道闸。

选项速查：

| 插件 | 选项 |
| --- | --- |
| `createAuthInterceptor` | `getToken`（必传，可异步）、`headerName`、`scheme`、`shouldAttach(config)` |
| `createRequestIdInterceptor` | `headerName`（默认 `X-Request-Id`）、`generateId()`（默认 randomUUID，缺失时退化为时间戳+随机数）、`keepExisting`（上游链路 ID 透传时开启，慎用） |
| `createUnwrapInterceptor` | `successCodes`（默认 `[0]`，允许字符串码）、`codeKey`、`dataKey`、`messageKey` |
| `createLoggerInterceptors` | `log(level, ...args)`（默认 console；不应抛错） |
| `withRetry` | `retries`（默认 2）、`methods`（默认 `['GET','HEAD']`，只约束默认规则）、`shouldRetry({error?,response?}, attempt, config)`（提供后完全接管）、`delayMs(attempt)`；取消永不重试；写方法默认不重试 |
| `withDedupe` | `methods`（默认 `['GET','HEAD']`）、`key(config)`（默认 `method + url + data`）；写方法默认放行，防双击显式 `methods: ['POST']` |
| adapter 链式增强 | `adapter.use(enhancer)`：注册顺序 = 请求流经顺序（`.use(withDedupe()).use(withRetry())` 即先去重再重试）；原 adapter 不被修改，分支链互不影响；装饰器可直接 `withRetry(adapter, opts)` 包，也可 `withRetry(opts)` 交给 `.use` |

### 5. 发请求

```ts
const res = await http.get('/users', { params: { page: 1 } })   // url 拼好 query
const res = await http.post('/users', { name: 'a' })
res.status  // number
res.data    // any
res.headers // Record<string, string>
```

### 6. 拦截器

三条独立的链，均按注册顺序执行：

```ts
// 请求链：注入 token 等
http.interceptors.request.use((config) => ({
  ...config,
  headers: { ...config.headers, Authorization: `Bearer ${getToken()}` },
}))

// 响应链（成功）：转换 / 剥壳
http.interceptors.response.use((res) => ({ ...res, data: res.data.data }))

// 错误链：所有失败都会经过——请求拦截器抛错、网络失败、非 2xx、响应链抛错
http.interceptors.error.use((err) => {
  report(err)   // 无返回值 = 放行（纯观察：上报 / toast）
})

http.interceptors.error.use((err) => {
  if (err.kind === 'http' && err.status === 401) {
    return { status: 200, data: null, headers: {} }   // 返回 RawResponse = 恢复
  }
  if (err.kind === 'network') {
    throw new RequestError('network', '网络不给力，请稍后重试')  // 替换错误
  }
})
```

错误链语义：

| 错误拦截器的行为 | 效果 |
| --- | --- |
| 返回 `RawResponse` | 恢复：直接作为最终结果，后续错误拦截器不再执行 |
| 返回 / 抛出 `RequestError` | 替换当前错误，继续错误链 |
| 无返回值（undefined） | 放行：错误继续抛给业务方，适合纯观察 |

> 要"所有错误都上报"，上报拦截器应最先注册——恢复发生后就不再通知后续拦截器。

### 7. 统一错误

所有失败最终抛出同一个 `RequestError`，按 `kind` 四分类：

```ts
import { RequestError } from './src'

try {
  await http.get('/x')
} catch (err) {
  if (err instanceof RequestError) {
    switch (err.kind) {
      case 'http':      // 非 2xx：err.status / err.data / err.headers
        break
      case 'business':  // HTTP 2xx 但业务码失败（unwrap 产生）：err.data 为原始 body
        break
      case 'abort':     // 请求被取消（AbortSignal / 平台取消）
        break
      case 'network':   // 传输层失败（含超时）：err.raw 保留原始错误可排查
        break
    }
  }
}
```

### 8. 统一取消

所有 adapter 都走标准 `AbortSignal`：

```ts
const controller = new AbortController()
http.get('/heavy-report', { signal: controller.signal }).catch(() => {})
controller.abort() // axios：原生取消；uni.request：桥接到 task.abort()；fetch：原生取消
```

### 9. 事件（进度等）

事件通过 `config.on` 订阅（与 axios 习惯对齐），进度事件统一为 `{ loaded, total?, progress? }`：

```ts
await http.post('/upload', formData, {
  on: {
    uploadProgress: ({ progress }) => bar.update(progress),   // 0-1
  },
})
await http.get('/big-file', {
  on: {
    downloadProgress: ({ loaded, total }) => console.log(loaded, total),
  },
})
```

**扩展策略**：`on` 是事件的唯一入口——以后新增事件（如 `headersReceived`、`chunkReceived`、`retry`）
只扩展 `RequestEvents` 接口并在对应 adapter 中 emit，`RequestConfig` 结构保持封闭，不再往根上加回调字段。

能力矩阵（平台差异在 adapter 内抹平，做不到的静默不触发）：

| adapter | 上传进度 | 下载进度 | 说明 |
| --- | --- | --- | --- |
| `axiosAdapter` | ✓ | ✓ | axios 1.x 浏览器 XHR 与 Node 流式适配器均支持 |
| `uniappAdapter` | ✓ | ✓ | `task.onProgressUpdate` 归一化（旧基础库缺失该 API 时跳过） |
| `fetchAdapter` | ✗ | ✓ | fetch 无上传进度（平台限制）；下载走 `res.body` 流式读取，`Content-Length` 缺失时 `total/progress` 为 undefined |

事件随 config 流经请求链，拦截器也能统一注入（如全局埋点）；每个并发调用者拿到各自的事件，不因去重共享而互相影响。

### 10. adapter 专有配置透传（adapterOptions）

平台特有参数（如 axios 的 `adapter`、fetch 的 `credentials`、uni.request 的 `enableHttp2`）
不进 `RequestConfig` 根——统一走 `adapterOptions` 逃生舱，按 adapter 名取用、仅对应 adapter 消费：

```ts
// 让 axios 走它自己的 fetch 适配器（axios 1.7+）
await http.get('/x', { adapterOptions: { axios: { adapter: 'fetch' } } })

// fetch 携带 cookie / 控制缓存
await http.get('/me', { adapterOptions: { fetch: { credentials: 'include', cache: 'no-store' } } })

// 自定义 adapter 按自己的名字取用
await http.get('/x', { adapterOptions: { myAdapter: { foo: 1 } } })
```

冲突规则：`url / method / headers / timeout / signal / validateStatus` 等契约派生字段
始终以 `RequestConfig` 为准，透传项覆盖不了它们——统一语义（状态码判断、取消、超时）不会被破坏。

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
| 主入口零依赖，adapter 即插件 | 依赖各自携带、按需导入，未被 import 的模块不进 bundle；小程序包体积与平台耦合由结构保证，而非约定 |
| 内置拦截器/装饰器不进门面 | 同一插件纪律；retry/dedupe 为 adapter 装饰器而非错误拦截器——错误链恢复不回响应链，装饰器在管道上游循环语义更干净 |
| adapter 只返回 `RawResponse`，不做任何判断 | 404/500 在两端表现不同（axios 抛错、uni 走 success），统一 resolve 交给 core 判 2xx，是两端语义归一的支点 |
| params 在 core 拼成完整 URL | 两端行为完全一致（数组重复 key、跳过 null/undefined、encode 规则），adapter 保持"哑" |
| 取消统一为 `name='AbortError'` 的 Error | uni-app 非 H5 运行时（小程序/App 端）没有 `DOMException`；`e.name === 'AbortError'` 的判定方式各端兼容 |
| core dispatch 前先查 `signal.aborted` | 防止"已取消还发请求"的竞态 |
| uniapp adapter 用 `settled` 标志 + `removeEventListener` | 防重复 settle；避免请求成功后 abort 监听器泄漏、对已完成 task 调 abort |
| 错误独立成链，undefined 即放行 | 观察（上报/toast）与恢复/替换同一入口；观察类钩子不必被迫 rethrow，语义一目了然 |
| 错误带 `raw` 字段 | 保留 axios 的 `error.code`（如 `ECONNABORTED` 超时）和 uni 的 `errMsg`，排查不丢信息 |

拦截器语义（最小实现）：request / response / error 三条链独立、均按注册顺序执行；
响应成功链任一环节抛错也会进入错误链；错误链的恢复 / 替换 / 放行语义见上文错误链语义表。

## 验证

```bash
npm install
npm run test       # vitest：31 个用例
npm run typecheck  # tsc --noEmit
```

- `tests/core.test.ts`：mock adapter，覆盖配置合并/拦截器顺序/params 拼接/错误三分类/拦截器恢复（同时验证门面零依赖可用）
- `tests/adapter.axios.test.ts`：真实 axios 打本地 `node:http` echo server
- `tests/adapter.uniapp.test.ts`：注入 fake `globalThis.uni` 模拟 uni.request 回调，覆盖成功/失败/取消/监听器清理
- `tests/custom-adapter.test.ts`：测试内手写 fetch adapter 接入，证明契约可独立实现
