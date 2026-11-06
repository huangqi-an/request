import axios from 'axios'
import { defineAdapter } from '../core'
import { createAbortError } from '../errors'
import type { AxiosRequestConfig } from 'axios'
import type { RequestConfig, RequestProgress } from '../types'

/** 归一化 axios 进度事件：total 缺失/为 0 时 progress 为 undefined */
function toProgress(loaded: number, total?: number | null): RequestProgress {
  const t = total && total > 0 ? total : undefined
  return {
    loaded,
    total: t,
    progress: t !== undefined ? Math.min(loaded / t, 1) : undefined,
  }
}

/**
 * Web 端 adapter 插件：基于 axios。按需导入，主入口不含本模块。
 * 经 defineAdapter 导出：可直接使用，也可 .use() 叠加装饰器（withRetry / withDedupe 等）。
 * - validateStatus: () => true：任何状态码都 resolve，404/500 等判断统一交给 core
 * - axios 原生支持 AbortSignal，取消语义在此翻译为统一的 AbortError
 */
export const axiosAdapter = defineAdapter(async (config: RequestConfig) => {
  const { uploadProgress, downloadProgress } = config.on ?? {}
  try {
    const res = await axios.request({
      // 专有配置先展开（如 adapter: 'fetch'）：契约派生字段在后覆盖，
      // url/method/headers/timeout/signal/validateStatus 始终以 RequestConfig 为准
      ...(config.adapterOptions?.axios as AxiosRequestConfig | undefined),
      url: config.url,
      method: config.method ?? 'GET',
      data: config.data,
      headers: config.headers,
      timeout: config.timeout,
      signal: config.signal,
      validateStatus: () => true,
      // axios 1.x 浏览器（XHR）与 Node（流式）适配器均产生进度事件
      ...(uploadProgress && {
        onUploadProgress: (e: { loaded: number; total?: number | null }) =>
          uploadProgress(toProgress(e.loaded, e.total)),
      }),
      ...(downloadProgress && {
        onDownloadProgress: (e: { loaded: number; total?: number | null }) =>
          downloadProgress(toProgress(e.loaded, e.total)),
      }),
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
