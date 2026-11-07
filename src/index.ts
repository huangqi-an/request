/**
 * 统一门面：契约 + 零依赖插件。
 * 携带平台依赖/耦合的适配器（axiosAdapter、uniappAdapter）不在这里，
 * 必须从 `./adapters/axios`、`./adapters/uniapp` 按需导入——
 * 这是防止 axios 进小程序包、保证 mp 端零依赖的结构保证。
 * 搭配 package.json 的 "sideEffects": false，未使用的导出会被 tree-shaking 干净剔除。
 */
export * from './types'
export * from './errors'
export { buildUrl, createRequest, defineAdapter } from './core'
export type { CreateRequestOptions, RequestInstance } from './core'
// 零依赖插件：fetch 适配器 + 全部内置拦截器 + 装饰器，从门面直接导入不产生包体代价
export { fetchAdapter } from './adapters/fetch'
export * from './interceptors'
export { withRetry } from './enhancers/retry'
export { withDedupe } from './enhancers/dedupe'
