import type { RequestConfig, RequestInterceptor } from '../types'

export interface AuthInterceptorOptions {
  /** 取 token；支持异步（如先静默刷新）。返回空值则跳过注入 */
  getToken: () => string | undefined | null | Promise<string | undefined | null>
  /** 注入的头名，默认 'Authorization' */
  headerName?: string
  /** token 前缀，默认 'Bearer '；不需要前缀传空字符串 */
  scheme?: string
  /** 返回 false 的请求不注入（如登录接口本身） */
  shouldAttach?: (config: RequestConfig) => boolean
}

/** 请求链拦截器：从 getToken() 注入凭证头 */
export function createAuthInterceptor(
  options: AuthInterceptorOptions,
): RequestInterceptor {
  const {
    getToken,
    headerName = 'Authorization',
    scheme = 'Bearer ',
    shouldAttach,
  } = options

  return async (config) => {
    if (shouldAttach && !shouldAttach(config)) return config
    const token = await getToken()
    if (!token) return config
    return {
      ...config,
      headers: { ...config.headers, [headerName]: `${scheme}${token}` },
    }
  }
}
