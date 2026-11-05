import { defineAdapter } from '../core'
import { createAbortError } from '../errors'
import type { RawResponse, RequestConfig } from '../types'

/** uni.request 的最小类型声明（按需扩展） */
interface UniRequestTask {
  abort(): void
}

interface UniRequestOptions {
  url: string
  method?: string
  data?: unknown
  /** 注意：uni.request 的请求头字段是 header，不是 headers */
  header?: Record<string, string>
  timeout?: number
  success?: (res: {
    statusCode: number
    data: unknown
    header?: Record<string, string>
  }) => void
  fail?: (err: { errMsg?: string }) => void
}

interface UniLike {
  request(options: UniRequestOptions): UniRequestTask
}

declare const uni: UniLike

/**
 * uni-app adapter 插件：基于 uni.request（uni-app 全局 API），按需导入，主入口不含本模块。
 * 经 defineAdapter 导出：可直接使用，也可 .use() 叠加装饰器。
 * 注意：uni-app ≠ 原生微信小程序——原生小程序的全局 API 是 wx.request，需要单独的 adapter。
 * - uni.request 的非 2xx 响应也走 success 且不 reject，所以这里原样 resolve，状态码判断统一交给 core
 * - fail 中的 abort（errMsg 形如 "request:fail abort"）翻译为统一 AbortError
 * - AbortSignal 桥接到 task.abort()，实现与其他 adapter 一致的统一取消
 */
export const uniappAdapter = defineAdapter((config: RequestConfig) => {
  return new Promise<RawResponse>((resolve, reject) => {
    const signal = config.signal

    // 请求发出前就已取消：直接终止，不碰 uni.request
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    // settled 防重复 settle；cleanup 保证结束后摘掉 abort 监听，避免泄漏
    let settled = false
    let task: UniRequestTask | undefined

    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      task?.abort()
      reject(createAbortError())
    }

    const settleSuccess = (res: RawResponse) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(res)
    }

    const settleFail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    // 先挂监听再发请求，避免"发出与取消之间"的竞态窗口
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      task = uni.request({
        url: config.url,
        method: config.method,
        data: config.data,
        header: config.headers,
        timeout: config.timeout,
        success: (res) => {
          // 非 2xx 响应也走 success，原样交给 core 统一判断
          settleSuccess({
            status: res.statusCode,
            data: res.data,
            headers: res.header ?? {},
          })
        },
        fail: (err) => {
          // 主动取消 → 统一取消语义
          if (/abort/i.test(err?.errMsg ?? '')) {
            onAbort()
            return
          }
          settleFail(err ?? new Error('request:fail'))
        },
      })
    } catch (error) {
      settleFail(error)
    }
  })
})
