import axios from 'axios'
import { defineAdapter } from '../core'
import { createAbortError } from '../errors'
import type { RequestConfig } from '../types'

/**
 * Web 端 adapter 插件：基于 axios。按需导入，主入口不含本模块。
 * 经 defineAdapter 导出：可直接使用，也可 .use() 叠加装饰器（withRetry / withDedupe 等）。
 * - validateStatus: () => true：任何状态码都 resolve，404/500 等判断统一交给 core
 * - axios 原生支持 AbortSignal，取消语义在此翻译为统一的 AbortError
 */
export const pcAdapter = defineAdapter(async (config: RequestConfig) => {
  try {
    const res = await axios.request({
      url: config.url,
      method: config.method ?? 'GET',
      data: config.data,
      headers: config.headers,
      timeout: config.timeout,
      signal: config.signal,
      validateStatus: () => true,
    })
    // AxiosHeaders → 普通 Record，保持与其他 adapter 形态一致
    const rawHeaders = res.headers as unknown as {
      toJSON?: () => Record<string, string>
    }
    return {
      status: res.status,
      data: res.data,
      headers: rawHeaders.toJSON?.() ?? { ...res.headers },
    }
  } catch (error) {
    // 取消（signal abort）→ 统一 AbortError；其余（网络错误/超时）原样抛给 core 包装
    if (axios.isCancel(error)) {
      throw createAbortError((error as Error)?.message)
    }
    throw error
  }
})
