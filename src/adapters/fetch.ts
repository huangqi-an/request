import { defineAdapter } from '../core'
import { createAbortError } from '../errors'
import type { RawResponse, RequestConfig, RequestProgress } from '../types'

/** 判断 data 是否可不经序列化直接作为 fetch 的 body（字符串或内置二进制类型） */
function isPassthroughBody(data: unknown): boolean {
  return (
    typeof data === 'string' ||
    data instanceof Blob ||
    data instanceof ArrayBuffer ||
    data instanceof Uint8Array ||
    data instanceof URLSearchParams ||
    (typeof FormData !== 'undefined' && data instanceof FormData)
  )
}

/**
 * 组装 body：
 * - GET/HEAD 不应有 body（fetch 对此直接抛错），data 被忽略，query 请用 params
 * - 字符串/内置二进制类型原样发送，不改动 Content-Type
 * - 对象/数组自动 JSON 序列化，未显式指定 Content-Type 时补 application/json（与 axios/uni 行为一致）
 */
function prepareBody(config: RequestConfig): {
  body?: BodyInit
  headers: Record<string, string>
} {
  const method = config.method ?? 'GET'
  const headers = { ...config.headers }
  const data = config.data

  if (data === undefined || data === null || method === 'GET' || method === 'HEAD') {
    return { headers }
  }
  if (isPassthroughBody(data)) {
    return { body: data as BodyInit, headers }
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json'
  }
  return { body: JSON.stringify(data), headers }
}

/** 响应解析：content-type 含 json 时自动 parse，解析失败保留原文（交由业务处理） */
function parseData(text: string, contentType: string): unknown {
  if (contentType.includes('json') && text !== '') {
    try {
      return JSON.parse(text)
    } catch {
      // 保留原文
    }
  }
  return text
}

/** 拼接分块字节后再整体解码：避免多字节 UTF-8 字符被块边界截断 */
function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * 下载进度：走 res.body 流式读取并逐块上报。
 * Content-Length 缺失（chunked 等）时 total/progress 为 undefined。
 */
async function readWithProgress(
  res: Response,
  onProgress: (progress: RequestProgress) => void,
): Promise<string> {
  const lengthHeader = Number(res.headers.get('content-length'))
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress({
      loaded,
      total,
      progress: total !== undefined ? Math.min(loaded / total, 1) : undefined,
    })
  }
  return new TextDecoder().decode(concatChunks(chunks, loaded))
}

/**
 * Web/Node/SSR adapter 插件：基于全局 fetch（零依赖，Node 18+ / 现代浏览器）。
 * 经 defineAdapter 导出：可直接使用，也可 .use() 叠加装饰器。
 * - 任何状态码都 resolve，判断统一交给 core
 * - fetch 无内建 timeout，用 AbortController 桥接 signal 与超时；
 *   超时抛普通错误（core 归类 kind='network'），与 axios/uni 的超时归类一致
 */
export const fetchAdapter = defineAdapter(
  async (config: RequestConfig): Promise<RawResponse> => {
    const { signal, timeout } = config
    // 与其他 adapter 一致：发出前已取消直接终止
    if (signal?.aborted) throw createAbortError()

    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onExternalAbort = () => controller.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })
    if (timeout !== undefined && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeout)
    }

    try {
      const { body, headers } = prepareBody(config)
      const { on } = config
      const res = await fetch(config.url, {
        // 专有配置先展开（如 credentials / cache / redirect）：契约派生字段在后覆盖
        ...(config.adapterOptions?.fetch as RequestInit | undefined),
        method: config.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      })
      // fetch 无上传进度（平台限制）；下载进度走流式读取
      const text =
        on?.downloadProgress && res.body
          ? await readWithProgress(res, on.downloadProgress)
          : await res.text()
      return {
        status: res.status,
        data: parseData(text, res.headers.get('content-type') ?? ''),
        headers: Object.fromEntries(res.headers.entries()),
      }
    } catch (error) {
      // 用户取消 → 统一 AbortError；桥接超时 → 普通错误（交 core 归类 network）
      if (signal?.aborted) throw createAbortError((error as Error)?.message)
      if (timedOut) throw new Error(`Request timed out after ${timeout}ms`)
      throw error
    } finally {
      signal?.removeEventListener('abort', onExternalAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
  },
)
