/**
 * 零依赖门面：仅包含 types / errors / core。
 * 不 import 任何 adapter —— axios / uni.request 等平台依赖都在
 * `./adapters/*` 插件模块里，由业务方按需导入（未被 import 的模块不会进 bundle）。
 */
export * from './types'
export * from './errors'
export { buildUrl, createRequest, defineAdapter } from './core'
export type { CreateRequestOptions, RequestInstance } from './core'
