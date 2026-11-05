import { isAbortError } from '../errors'
import type { AdapterEnhancer, RawResponse, RequestAdapter, RequestConfig } from '../types'

/**
 * 默认只重试幂等的安全方法。
 * 写方法（POST/PUT/DELETE）默认不重试：网络错误可能是"请求已到达服务端但响应丢失"，
 * 自动重发会重复执行非幂等操作（如重复扣款）。
 */
const SAFE_METHODS = ['GET', 'HEAD']

export interface RetryFailure {
  /** adapter 抛出的错误（取消为 name='AbortError'） */
  error?: unknown
  /** adapter 返回的非 2xx 响应 */
  response?: RawResponse
}

export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 2 */
  retries?: number
  /**
   * 默认重试规则覆盖的方法，默认 ['GET', 'HEAD']（幂等）。
   * 只约束默认规则；提供 shouldRetry 后完全由 shouldRetry 决定。
   */
  methods?: string[]
  /**
   * 自定义是否重试，提供后完全接管默认规则（methods 不再生效）。
   * 默认：抛错且方法幂等 → 重试；非 2xx 响应 / 取消 → 不重试。
   * 需要对写方法重试时自行判断（如请求已带幂等键 Idempotency-Key）。
   */
  shouldRetry?: (
    failure: RetryFailure,
    attempt: number,
    config: RequestConfig,
  ) => boolean
  /** 第 attempt 次重试前的等待毫秒，默认不等待 */
  delayMs?: (attempt: number) => number
}

/**
 * adapter 装饰器：失败自动重试（不引 core，可与任何 adapter 组合）。
 * 与错误链恢复不同：重试成功的响应会正常走完整 core 管道（响应链剥壳等）。
 *
 * 两种形态：
 * - withRetry(adapter, options)：直接包装
 * - withRetry(options)：返回装饰器，交给 adapter.use() 组合
 */
export function withRetry(options?: RetryOptions): AdapterEnhancer
export function withRetry(adapter: RequestAdapter, options?: RetryOptions): RequestAdapter
export function withRetry(
  first?: RequestAdapter | RetryOptions,
  maybeOptions?: RetryOptions,
): RequestAdapter | AdapterEnhancer {
  const options: RetryOptions =
    first !== undefined && typeof first !== 'function' ? first : (maybeOptions ?? {})

  const decorate = (adapter: RequestAdapter): RequestAdapter => {
    const { retries = 2, shouldRetry, delayMs } = options
    const methods = options.methods ?? SAFE_METHODS
    const defaultShouldRetry = (failure: RetryFailure, _attempt: number, config: RequestConfig) =>
      failure.error !== undefined && methods.includes(config.method ?? 'GET')
    const decideRetry: (
      failure: RetryFailure,
      attempt: number,
      config: RequestConfig,
    ) => boolean = shouldRetry ?? defaultShouldRetry

    return async (config) => {
      let attempt = 0
      for (;;) {
        let failure: RetryFailure
        try {
          const res = await adapter(config)
          if (res.status >= 200 && res.status < 300) return res
          failure = { response: res }
        } catch (error) {
          // 取消语义永不重试
          if (isAbortError(error)) throw error
          failure = { error }
        }

        const giveUp = () => {
          if (failure.error !== undefined) throw failure.error
          return failure.response as RawResponse
        }
        if (attempt >= retries) return giveUp()
        if (!decideRetry(failure, attempt + 1, config)) {
          return giveUp()
        }

        attempt++
        const delay = delayMs?.(attempt)
        if (delay && delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }
  }

  return typeof first === 'function' ? decorate(first) : decorate
}
