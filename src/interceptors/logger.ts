import type {
  ErrorInterceptor,
  RequestInterceptor,
  ResponseInterceptor,
} from '../types'

export type LogLevel = 'debug' | 'warn'
export type LogFn = (level: LogLevel, ...args: unknown[]) => void

export interface LoggerInterceptorsOptions {
  /**
   * 自定义日志函数（如接埋点 SDK）。注意：不应抛错——
   * request/response 链中抛错会进入错误链，error 链中抛错会替换原错误。
   */
  log?: LogFn
}

const defaultLog: LogFn = (level, ...args) => {
  if (level === 'warn') console.warn(...args)
  else console.log(...args)
}

/**
 * 三链日志：返回 request / response / error 三件套，分别注册到对应链。
 * - request：method / url / params
 * - response：status / 耗时 / url（读 core 注入的 res.durationMs 与 res.config）
 * - error：kind / message / url（读 err.config）
 */
export function createLoggerInterceptors(options: LoggerInterceptorsOptions = {}): {
  request: RequestInterceptor
  response: ResponseInterceptor
  error: ErrorInterceptor
} {
  const log = options.log ?? defaultLog

  return {
    request: (config) => {
      log('debug', '[request]', config.method ?? 'GET', config.url, config.params ?? '')
      return config
    },
    response: (res) => {
      log('debug', '[response]', res.status, `${res.durationMs ?? '?'}ms`, res.config?.url ?? '')
      return res
    },
    error: (error) => {
      log('warn', '[error]', error.kind, error.message, error.config?.url ?? '')
    },
  }
}
