import type { RequestConfig } from './types'

/**
 * 统一错误四分类：
 * - http：收到响应但状态码非 2xx（业务层面最常处理的一类）
 * - business：HTTP 2xx 但业务码失败（由内置 unwrap 拦截器产生）
 * - abort：请求被取消（AbortSignal 或平台取消语义）
 * - network：传输层失败，含超时；通过 raw 可拿到原始错误（axios 的 error.code / uni 的 errMsg）
 */
export type RequestErrorKind = 'abort' | 'http' | 'business' | 'network'

export interface RequestErrorOptions {
  status?: number
  data?: unknown
  headers?: Record<string, string>
  config?: RequestConfig
  /** 原始错误：axios error / uni fail 回调的 err，便于排查 */
  raw?: unknown
}

export class RequestError extends Error {
  readonly kind: RequestErrorKind
  readonly status?: number
  readonly data?: unknown
  readonly headers?: Record<string, string>
  readonly config?: RequestConfig
  readonly raw?: unknown

  constructor(
    kind: RequestErrorKind,
    message: string,
    options: RequestErrorOptions = {},
  ) {
    super(message)
    this.name = 'RequestError'
    this.kind = kind
    this.status = options.status
    this.data = options.data
    this.headers = options.headers
    this.config = options.config
    this.raw = options.raw
  }
}

/**
 * 生成统一形态的 AbortError。
 * 不用 DOMException：小程序运行时没有 DOMException，
 * Error + name='AbortError' 与 `e.name === 'AbortError'` 的通用判定方式兼容。
 */
export function createAbortError(message = 'The request was aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** 是否为取消错误（兼容原生 DOMException/AbortController 与本库生成的） */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Error).name === 'AbortError'
  )
}
