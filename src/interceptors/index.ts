/**
 * 内置拦截器插件：零依赖纯函数工厂，按需导入。
 * 刻意不在门面 index.ts re-export——保持"门面=契约、插件按需"的纪律。
 */
export { createAuthInterceptor } from './auth'
export type { AuthInterceptorOptions } from './auth'
export { createUnwrapInterceptor } from './unwrap'
export type { UnwrapInterceptorOptions } from './unwrap'
export { createLoggerInterceptors } from './logger'
export type { LoggerInterceptorsOptions, LogFn, LogLevel } from './logger'
export { createRequestIdInterceptor } from './request-id'
export type { RequestIdInterceptorOptions } from './request-id'
