import { createAbortError, isAbortError, RequestError } from './errors'
import type {
  AdapterEnhancer,
  ChainableAdapter,
  ErrorInterceptor,
  RawResponse,
  RequestAdapter,
  RequestConfig,
  RequestInterceptor,
  RequestMethod,
  ResponseInterceptor,
} from './types'

export interface CreateRequestOptions {
  /** 必传：adapter 插件（pcAdapter / uniappAdapter / 自定义 adapter / 测试 mock） */
  adapter: RequestAdapter
  baseURL?: string
  headers?: Record<string, string>
  timeout?: number
}

export interface RequestInstance {
  request<T = unknown>(config: RequestConfig): Promise<RawResponse<T>>
  get<T = unknown>(
    url: string,
    config?: Omit<RequestConfig, 'url' | 'method'>,
  ): Promise<RawResponse<T>>
  post<T = unknown>(
    url: string,
    data?: unknown,
    config?: Omit<RequestConfig, 'url' | 'method' | 'data'>,
  ): Promise<RawResponse<T>>
  put<T = unknown>(
    url: string,
    data?: unknown,
    config?: Omit<RequestConfig, 'url' | 'method' | 'data'>,
  ): Promise<RawResponse<T>>
  delete<T = unknown>(
    url: string,
    config?: Omit<RequestConfig, 'url' | 'method'>,
  ): Promise<RawResponse<T>>
  interceptors: {
    request: { use(interceptor: RequestInterceptor): void }
    /** 成功链：转换 / 剥壳 */
    response: { use(interceptor: ResponseInterceptor): void }
    /**
     * 错误链：所有失败都会经过（请求拦截器抛错 / 网络失败 / 非 2xx / 响应链抛错）。
     * 返回 RawResponse = 恢复；返回/抛出 RequestError = 替换；无返回值 = 放行（观察）。
     */
    error: { use(interceptor: ErrorInterceptor): void }
  }
}

const ABSOLUTE_URL_RE = /^https?:\/\//

/**
 * 拼接 baseURL + url，并把 params 序列化为 query。
 * - 绝对 URL 忽略 baseURL
 * - 跳过 null / undefined；数组值序列化为重复 key（?id=1&id=2）
 * - url 已带 ? 时用 & 追加
 * params 统一在这里处理，保证两端一致，adapter 无需各自实现。
 */
export function buildUrl(
  baseURL: string | undefined,
  url: string,
  params?: Record<string, unknown>,
): string {
  let full = url
  if (baseURL && !ABSOLUTE_URL_RE.test(url)) {
    full = `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
  }
  if (!params) return full

  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((item) => [key, item] as const)
        : [[key, value] as const],
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
  if (pairs.length === 0) return full

  return full + (full.includes('?') ? '&' : '?') + pairs.join('&')
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300
}

/** 高精度计时；performance 不存在的运行时（部分小程序环境）退化为 Date.now */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 判断错误拦截器的返回值是否为恢复（RawResponse 形状） */
function isRawResponseLike(value: unknown): value is RawResponse {
  return (
    typeof value === 'object' && value !== null && 'status' in value && 'data' in value
  )
}

/** 把任意抛出的错误归一化为 RequestError（已是则透传） */
function toRequestError(error: unknown, config?: RequestConfig): RequestError {
  if (error instanceof RequestError) return error
  if (isAbortError(error)) {
    return new RequestError('abort', (error as Error).message, {
      config,
      raw: error,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RequestError('network', message || 'Network request failed', {
    config,
    raw: error,
  })
}

/**
 * adapter 的显式扩展点：把任意（含第三方）adapter 变为可链式增强的 adapter，
 * 同时为自定义 adapter 的实现函数提供参数类型推断。
 *
 * const myAdapter = defineAdapter(async (config) => {
 *   // config.url 已是 core 拼好 params 的完整地址
 *   // 返回 RawResponse；取消时抛 name='AbortError' 的错误
 * }).use(withRetry()).use(withDedupe())   // 注册顺序 = 请求流经顺序
 *
 * 返回值本身仍是合法的 RequestAdapter，可直接传给 createRequest。
 */
export function defineAdapter(adapter: RequestAdapter): ChainableAdapter {
  const chain = (enhancers: AdapterEnhancer[]): ChainableAdapter => {
    let composed: RequestAdapter | undefined
    const wrapped = ((config: RequestConfig) => {
      // 惰性组合并缓存：装饰器工厂只在首次请求时执行一次，.use 不触发重建
      if (composed === undefined) {
        composed = enhancers.reduceRight((acc, enhance) => enhance(acc), adapter)
      }
      return composed(config)
    }) as ChainableAdapter
    wrapped.use = (enhancer) => chain([...enhancers, enhancer])
    return wrapped
  }
  return chain([])
}

export function createRequest(options: CreateRequestOptions): RequestInstance {
  const requestInterceptors: RequestInterceptor[] = []
  const responseInterceptors: ResponseInterceptor[] = []
  const errorInterceptors: ErrorInterceptor[] = []

  async function request<T = unknown>(
    input: RequestConfig,
  ): Promise<RawResponse<T>> {
    // 1. 合并实例默认值，请求级配置优先
    let config: RequestConfig = {
      ...input,
      method: (input.method ?? 'GET') as RequestMethod,
      baseURL: input.baseURL ?? options.baseURL,
      timeout: input.timeout ?? options.timeout,
      headers: { ...options.headers, ...input.headers },
    }

    try {
      // 2. 请求拦截器，按注册顺序执行
      for (const interceptor of requestInterceptors) {
        config = await interceptor(config)
      }

      // 3. params 统一在 core 拼进 url，并回写 config——错误链与响应链拿到的都是完整地址
      config = { ...config, url: buildUrl(config.baseURL, config.url, config.params) }

      // 4. dispatch 前检查取消，避免"已取消还发请求"的竞态
      if (config.signal?.aborted) throw createAbortError()

      // 5. 调 adapter，任何失败在此归一化；耗时与最终 config 由 core 统一注入响应
      const startedAt = now()
      let res: RawResponse
      try {
        res = await options.adapter({ ...config, params: undefined })
      } catch (error) {
        throw toRequestError(error, config)
      }
      res.durationMs = Math.round(now() - startedAt)
      res.config = { ...config }

      // 6. 状态码判断统一在 core：非 2xx → http 错误（两端行为一致的关键）
      if (!isOkStatus(res.status)) {
        throw new RequestError('http', `Request failed with status ${res.status}`, {
          status: res.status,
          data: res.data,
          headers: res.headers,
          config,
        })
      }

      // 7. 响应拦截器（成功链，按注册顺序执行）
      for (const onFulfilled of responseInterceptors) {
        res = await onFulfilled(res)
      }
      return res as RawResponse<T>
    } catch (error) {
      // 8. 统一错误出口：错误链按注册顺序执行
      //    返回 RawResponse = 恢复；返回/抛出 RequestError = 替换；无返回值 = 放行（观察）
      let current = toRequestError(error, config)
      for (const onError of errorInterceptors) {
        let out: RawResponse | RequestError | void
        try {
          out = await onError(current)
        } catch (thrown) {
          current = toRequestError(thrown, config)
          continue
        }
        if (isRawResponseLike(out)) return out as RawResponse<T>
        if (out instanceof RequestError) current = out
      }
      throw current
    }
  }

  return {
    request,
    get: (url, config) => request({ ...config, url, method: 'GET' }),
    post: (url, data, config) => request({ ...config, url, data, method: 'POST' }),
    put: (url, data, config) => request({ ...config, url, data, method: 'PUT' }),
    delete: (url, config) => request({ ...config, url, method: 'DELETE' }),
    interceptors: {
      request: {
        use: (interceptor) => {
          requestInterceptors.push(interceptor)
        },
      },
      response: {
        use: (interceptor) => {
          responseInterceptors.push(interceptor)
        },
      },
      error: {
        use: (interceptor) => {
          errorInterceptors.push(interceptor)
        },
      },
    },
  }
}
