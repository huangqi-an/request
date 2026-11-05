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
