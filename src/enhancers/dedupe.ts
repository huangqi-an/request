import type { AdapterEnhancer, RawResponse, RequestAdapter, RequestConfig } from '../types'

/**
 * 默认只去重幂等的安全方法。
 * 写方法（POST/PUT/DELETE）默认放行：去重的 share 语义不会"多发"，但会"少发"——
 * 对故意并发的非幂等请求（如计数 +1）静默合并等于丢操作。
 */
const SAFE_METHODS = ['GET', 'HEAD']

function defaultKey(config: RequestConfig): string {
  let dataKey = ''
  if (config.data !== undefined) {
    try {
      dataKey = JSON.stringify(config.data)
    } catch {
      // 无法稳定序列化的 data 不参与去重：宁可漏去重，不可错合并
      dataKey = `${Math.random()}`
    }
  }
  return `${config.method ?? 'GET'} ${config.url} ${dataKey}`
}

export interface DedupeOptions {
  /**
   * 参与去重的方法，默认 ['GET', 'HEAD']（幂等）。
   * 防双击提交等场景显式传入（如 methods: ['POST']），此时相同载荷的并发提交共享同一结果。
   */
  methods?: string[]
  /**
   * 去重键，默认 `${method} ${url} ${JSON.stringify(data)}`。
   * params 已拼进 url，无需重复纳入；data 键序不同会被视为不同请求（宁可漏去重，不可错合并）。
   */
  key?: (config: RequestConfig) => string
}

/**
 * adapter 装饰器：进行中的相同请求共享同一个 Promise。
 * - 默认只对幂等方法（GET/HEAD）生效，写方法默认放行
 * - 请求 settle 后自动清理，不影响后续新请求
 * - 共享的是同一个 RawResponse 对象；响应链拦截器用 {...res} 展开产生新对象，不会互相污染
 *
 * 两种形态：
 * - withDedupe(adapter, options)：直接包装
 * - withDedupe(options)：返回装饰器，交给 adapter.use() 组合
 */
export function withDedupe(options?: DedupeOptions): AdapterEnhancer
export function withDedupe(adapter: RequestAdapter, options?: DedupeOptions): RequestAdapter
export function withDedupe(
  first?: RequestAdapter | DedupeOptions,
  maybeOptions?: DedupeOptions,
): RequestAdapter | AdapterEnhancer {
  const options: DedupeOptions =
    first !== undefined && typeof first !== 'function' ? first : (maybeOptions ?? {})

  const decorate = (adapter: RequestAdapter): RequestAdapter => {
    const inFlight = new Map<string, Promise<RawResponse>>()
    const methods = options.methods ?? SAFE_METHODS
    const keyOf = options.key ?? defaultKey

    return (config) => {
      // 非幂等方法直接放行，不参与去重
      if (!methods.includes(config.method ?? 'GET')) return adapter(config)

      const key = keyOf(config)
      const pending = inFlight.get(key)
      if (pending) return pending

      const promise = adapter(config).finally(() => {
        inFlight.delete(key)
      })
      inFlight.set(key, promise)
      return promise
    }
  }

  return typeof first === 'function' ? decorate(first) : decorate
}
