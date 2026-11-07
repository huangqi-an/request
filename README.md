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

## 装饰器

通过 `adapter.use()` 叠加，注册顺序即请求经过顺序。

| 装饰器 | 作用 |
| --- | --- |
| `withRetry` | 失败自动重试；默认仅幂等方法（GET/HEAD），写方法默认不重试 |
| `withDedupe` | 进行中的相同请求共享结果；默认仅幂等方法，写方法默认不去重 |

```ts
const adapter = fetchAdapter.use(withDedupe()).use(withRetry({ retries: 2 }))
```

## 适配器

| 适配器 | 依赖 | 适用 |
| --- | --- | --- |
| `fetchAdapter` | 无 | Web / Node.js 18+ / SSR |
| `axiosAdapter` | axios | 需要 axios 生态时（从 `@huangqi_an/request/adapters/axios` 导入） |
| `uniappAdapter` | 全局 `uni` | uni-app（H5 / 小程序 / App），从 `@huangqi_an/request/adapters/uniapp` 导入 |
| 自定义 | — | wx 原生小程序、Taro、Electron 等，按契约实现 |

平台差异：三个适配器的超时与取消行为一致；上传进度 fetch 不支持；PATCH 在微信小程序受
`wx.request` 方法白名单限制。详见[能力矩阵](https://github.com/huangqi-an/request/blob/main/docs/api.md#能力矩阵)。

## License

[MIT](./LICENSE)
