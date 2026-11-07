# @huangqi_an/request

跨平台 HTTP 请求库。同一套调用代码运行于浏览器、Node.js 与 uni-app，平台差异由适配器处理。

- 核心零依赖；适配器、拦截器、装饰器均为插件，按需导入
- 统一行为：状态码判定、错误分类（`abort` / `http` / `business` / `network`）、取消、超时、进度事件、拦截器
- TypeScript 编写，含完整类型声明

[完整 API 文档](https://github.com/huangqi-an/request/blob/main/docs/api.md) · [工作原理与设计决策](https://github.com/huangqi-an/request/blob/main/docs/design.md)

## 安装

```bash
npm install @huangqi_an/request
# 使用 axiosAdapter 时需要自行安装 axios（optional peer dependency）：
npm install axios
```

也可将 `src/` 复制到项目中以源码形式使用（导入路径替换为相对路径）。

## 快速开始

Web / Node.js / SSR：

```ts
import { createRequest, fetchAdapter, withRetry, withDedupe } from '@huangqi_an/request'

export const http = createRequest({
  // 装饰器可选；不使用时传入 fetchAdapter 即可
  adapter: fetchAdapter.use(withDedupe()).use(withRetry()),
  baseURL: 'https://api.example.com',
  timeout: 15000,
})

const res = await http.get('/users', { params: { page: 1 } })
res.data       // 响应体
res.status     // 200
res.durationMs // 耗时（毫秒）
```

uni-app：

```ts
import { createRequest } from '@huangqi_an/request'
import { uniappAdapter } from '@huangqi_an/request/adapters/uniapp'

export const http = createRequest({ adapter: uniappAdapter, baseURL: 'https://api.example.com' })
```

错误处理——所有失败抛出 `RequestError`，按 `kind` 分类：

```ts
import { RequestError } from '@huangqi_an/request'

try {
  await http.post('/orders', { sku: 1 })
} catch (err) {
  if (err instanceof RequestError) {
    switch (err.kind) {
      case 'http':      break // 非 2xx：err.status / err.data
      case 'business':  break // 业务码失败：err.data 为原始响应体
      case 'abort':     break // 请求被取消
      case 'network':   break // 传输失败（含超时）：err.raw 为原始错误
    }
  }
}
```

## 拦截器

三条链：`request`（改写请求）、`response`（转换响应）、`error`（处理失败，可恢复）。

```ts
http.interceptors.request.use(createAuthInterceptor({ getToken }))
http.interceptors.request.use(createRequestIdInterceptor())
http.interceptors.response.use(createUnwrapInterceptor())
```

| 拦截器 | 作用 |
| --- | --- |
| `createAuthInterceptor` | 注入凭证头 |
| `createRequestIdInterceptor` | 为每个请求注入唯一 ID |
| `createUnwrapInterceptor` | 剥离 `{code, data, message}` 业务壳，业务码失败抛 `kind: 'business'` |
| `createLoggerInterceptors` | 三链日志 |

自定义拦截器就是一个符合链签名的函数，无需任何注册 API 之外的封装：

```ts
// 请求链：入参 config，返回改写后的 config（可异步）
http.interceptors.request.use((config) => ({
  ...config,
  headers: { ...config.headers, 'X-Locale': 'zh-CN' },
}))

// 响应链：入参 RawResponse，返回 RawResponse；抛出的错误进入错误链
http.interceptors.response.use((res) => {
  if (res.status === 204) return { ...res, data: null }
  return res
})

// 错误链：入参 RequestError。返回 undefined 表示放行，返回 RawResponse 表示恢复
http.interceptors.error.use((err) => {
  if (err.kind === 'network') notify('网络异常')
})
```

各选项与完整语义见 [API 文档 · 拦截器](https://github.com/huangqi-an/request/blob/main/docs/api.md#拦截器)。

## 装饰器

通过 `adapter.use()` 叠加，注册顺序即请求经过顺序。

| 装饰器 | 作用 |
| --- | --- |
| `withRetry` | 失败自动重试；默认仅幂等方法（GET/HEAD），写方法默认不重试 |
| `withDedupe` | 进行中的相同请求共享结果；默认仅幂等方法，写方法默认不去重 |

```ts
const adapter = fetchAdapter.use(withDedupe()).use(withRetry({ retries: 2 }))
```

自定义装饰器实现 `AdapterEnhancer` 类型——一个"接收适配器、返回适配器"的函数：

```ts
import type { AdapterEnhancer } from '@huangqi_an/request'

const withTiming: AdapterEnhancer = (adapter) => async (config) => {
  const start = Date.now()
  const res = await adapter(config)
  console.log(`${config.method} ${config.url} ${Date.now() - start}ms`)
  return res
}

const adapter = fetchAdapter.use(withTiming)
```

完整选项与语义见 [API 文档 · 适配器装饰器](https://github.com/huangqi-an/request/blob/main/docs/api.md#适配器装饰器)。

## 适配器

| 适配器 | 依赖 | 适用 |
| --- | --- | --- |
| `fetchAdapter` | 无 | Web / Node.js 18+ / SSR |
| `axiosAdapter` | axios | 需要 axios 生态时（从 `@huangqi_an/request/adapters/axios` 导入） |
| `uniappAdapter` | 全局 `uni` | uni-app（H5 / 小程序 / App），从 `@huangqi_an/request/adapters/uniapp` 导入 |
| 自定义 | — | wx 原生小程序、Taro、Electron 等，按契约实现 |

自定义适配器契约共三条：

1. 入参为 `RequestConfig`，其中 `url` 已拼接完成，是完整地址。
2. 返回 `RawResponse`（`status` / `data` / `headers`），任意状态码都 resolve，状态码判定由 core 负责。
3. 取消时抛出 `name='AbortError'` 的错误；其余错误直接抛出，core 统一包装为 `kind: 'network'`。

```ts
import { defineAdapter } from '@huangqi_an/request'

const myAdapter = defineAdapter(async (config) => {
  const res = await myTransport.request(config.url, config)
  return { status: res.status, data: res.body, headers: res.headers }
})

const http = createRequest({ adapter: myAdapter })
```

平台特有方法（如小程序的 `uploadFile`）通过 `.extend()` 附加到适配器上，附加方法可经过完整
管道；错误链、事件、透传的用法见 [API 文档](https://github.com/huangqi-an/request/blob/main/docs/api.md)。

## License

[MIT](./LICENSE)
