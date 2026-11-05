import type { RequestConfig, RequestInterceptor } from '../types'

/**
 * 默认 ID 生成器：优先 crypto.randomUUID（安全上下文/新运行时），
 * 运行时缺失（部分小程序/旧 WebView）退化为时间戳+随机数——
 * 请求 ID 只求会话内唯一便于关联，不要求密码学强度。
 */
function defaultGenerateId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface RequestIdInterceptorOptions {
  /** 请求头名，默认 'X-Request-Id' */
  headerName?: string
  /** 自定义 ID 生成器（如接入 tracing/Sentry 等链路库） */
  generateId?: () => string
  /**
   * 请求已携带该头时不覆盖（用于上游链路 ID 透传），默认 false。
   * 注意：实例级默认头也算"已携带"，开启后会导致所有请求共用一个 ID，慎用。
   */
  keepExisting?: boolean
}

/**
 * 请求链拦截器：为每个请求生成唯一 ID 注入请求头，用于前后端日志关联与报障定位。
 * - core 会把最终 config 盖章到 RawResponse.config 与 RequestError.config，
 *   因此响应链日志、错误上报都能取到同一个 ID
 * - 重试共享同一 config：同一次逻辑请求（含重试）带同一个 ID，服务端可识别重发
 */
export function createRequestIdInterceptor(
  options: RequestIdInterceptorOptions = {},
): RequestInterceptor {
  const {
    headerName = 'X-Request-Id',
    generateId = defaultGenerateId,
    keepExisting = false,
  } = options

  return (config: RequestConfig) => {
    if (keepExisting && config.headers?.[headerName]) return config
    return {
      ...config,
      headers: { ...config.headers, [headerName]: generateId() },
    }
  }
}
