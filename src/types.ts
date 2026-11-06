import type { RequestError } from './errors'

/** 统一的请求方法，axios 与 uni.request 均可表达 */
export type RequestMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'

/**
 * 请求事件集合：adapter 在支持的平台能力上触发。
 * 扩展策略：新增事件只加这里的可选成员（并在对应 adapter 中 emit），
 * RequestConfig 结构保持封闭——不再往根上加回调字段。
 */
export interface RequestEvents {
  /** 上传进度（字节数）；axios/uniapp 支持，fetch 平台不支持（README 有能力矩阵） */
  uploadProgress?: (progress: RequestProgress) => void
  /** 下载进度（字节数）；fetch 走流式读取，Content-Length 缺失时 total/progress 为 undefined */
  downloadProgress?: (progress: RequestProgress) => void
}

/**
 * adapter 专有配置透传袋：按 adapter 名取用，仅对应 adapter 消费，其它 adapter 忽略。
 * 这是平台特有能力的统一逃生舱（如 axios 的 adapter/responseType、fetch 的 credentials/cache、
 * uni.request 的 enableHttp2）——RequestConfig 保持平台无关，特有参数走这里，不往根上加字段。
 *
 * 冲突规则：契约派生字段（url/method/headers/timeout/signal/validateStatus 等）
 * 以 RequestConfig 为准，透传项覆盖不了它们——统一语义不被破坏。
 */
export interface AdapterOptions {
  /** axiosAdapter 透传给 axios.request 的额外配置（axios 专有类型见 axios 官方文档） */
  axios?: Record<string, unknown>
  /** uniappAdapter 透传给 uni.request 的额外配置 */
  uniapp?: Record<string, unknown>
  /** fetchAdapter 透传给 fetch() 的额外配置（credentials / cache / redirect 等） */
  fetch?: Record<string, unknown>
  /** 自定义 adapter 可按自己的名字扩展（结构由该 adapter 决定） */
  [adapter: string]: Record<string, unknown> | undefined
}

/**
 * 平台无关的请求配置，adapter 的唯一输入。
 * 注意：adapter 拿到的 url 已经是 core 拼好 params 的完整地址。
 */
export interface RequestConfig {
  url: string
  method?: RequestMethod
  baseURL?: string
  /** query 参数，由 core 统一序列化后拼进 url，adapter 无需感知 */
  params?: Record<string, unknown>
  data?: unknown
  headers?: Record<string, string>
  timeout?: number
  signal?: AbortSignal
  /** 事件订阅（唯一的扩展点：新增事件只扩展 RequestEvents，不改 RequestConfig） */
  on?: RequestEvents
  /** adapter 专有配置透传（见 AdapterOptions） */
  adapterOptions?: AdapterOptions
}

/**
 * 平台无关的原始响应，adapter 的唯一输出。不做任何业务判断（含状态码）。
 * durationMs 与 config 由 core 统一注入（adapter 无需填写）。
 */
export interface RawResponse<T = unknown> {
  status: number
  data: T
  headers: Record<string, string>
  /** adapter 调用耗时（毫秒），core 注入；供日志/性能监控使用 */
  durationMs?: number
  /** 发起请求的最终配置（url 已拼好 params），core 注入；供响应链做条件逻辑 */
  config?: RequestConfig
}

/** 进度事件：loaded/total 为字节数，progress 为 0-1（total 未知时为 undefined） */
export interface RequestProgress {
  loaded: number
  /** 总字节数；服务端未返回长度（chunked 等）时为 undefined */
  total?: number
  /** 0-1；total 未知时为 undefined */
  progress?: number
}

/**
 * adapter 契约：发请求、返回原始结果、翻译取消语义。
 * 状态码判断、错误归一化、拦截器全部由 core 负责，adapter 保持"哑"。
 */
export type RequestAdapter = (config: RequestConfig) => Promise<RawResponse>

/** adapter 装饰器：输入 adapter，输出增强后的 adapter（retry/dedupe 以该形态参与 .use 组合） */
export type AdapterEnhancer = (adapter: RequestAdapter) => RequestAdapter

/**
 * 可链式增强的 adapter：本身可直接当 RequestAdapter 用，同时提供 .use 叠加装饰器。
 * 注册顺序 = 请求流经顺序（与拦截器链一致）：adapter.use(a).use(b) 时请求依次经过 a → b → adapter。
 */
export interface ChainableAdapter extends RequestAdapter {
  /** 在外层叠加一个装饰器，返回新的链式 adapter（原 adapter 不被修改） */
  use: (enhancer: AdapterEnhancer) => ChainableAdapter
}

/** 请求拦截器：返回新 config（可异步） */
export type RequestInterceptor = (
  config: RequestConfig,
) => RequestConfig | Promise<RequestConfig>

/** 响应拦截器（成功链）：转换 / 剥壳 */
export type ResponseInterceptor = (
  res: RawResponse,
) => RawResponse | Promise<RawResponse>

/**
 * 错误拦截器：所有失败都会按注册顺序经过——
 * 请求拦截器抛错 / 网络失败（含超时）/ 非 2xx / 响应成功链抛错。
 *
 * - 返回 RawResponse → 恢复：结束错误链，直接作为最终结果（后续错误拦截器不再执行）
 * - 返回 RequestError → 用它替换当前错误，继续错误链
 * - 无返回值（undefined）→ 放行：适合纯观察（上报 / toast / 401 跳转）
 * - 抛错 → 视为替换错误，继续错误链
 */
export type ErrorInterceptor = (
  error: RequestError,
) => RawResponse | RequestError | void | Promise<RawResponse | RequestError | void>
