import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequest, defineAdapter } from '../src'
import type { RawResponse } from '../src'

/**
 * 自定义 adapter 能力验证：不依赖库内置的 pc/mp adapter，
 * 仅凭公开契约（RequestConfig → RawResponse）接入一个 fetch adapter。
 * 同时证明 Node/SSR 场景下可以完全绕开 axios。
 */

// 契约：输入的 config.url 已由 core 拼好 params；取消时抛 name='AbortError' 的错误
const fetchAdapter = defineAdapter(async (config): Promise<RawResponse> => {
  const res = await fetch(config.url, {
    method: config.method ?? 'GET',
    headers: config.headers,
    body: config.data != null ? JSON.stringify(config.data) : undefined,
    signal: config.signal,
  })
  return {
    status: res.status,
    data: await res.json(),
    headers: Object.fromEntries(res.headers.entries()),
  }
})

let server: Server
let baseURL: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // 永不响应的路由：留给"进行中取消"的用例
    if (req.url === '/slow') return
    if (req.url === '/404') {
      respond(404, { msg: 'not found' })
      return
    }
    respond(200, { ok: true, url: req.url })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  baseURL = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('自定义 adapter（fetch 插件）', () => {
  it('fetch adapter 经 createRequest 正常工作', async () => {
    const http = createRequest({ adapter: fetchAdapter, baseURL })
    const res = await http.get('/echo', { params: { a: 1 } })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ ok: true, url: '/echo?a=1' })
  })

  it('core 语义对自定义 adapter 同样生效：404 → kind=http', async () => {
    const http = createRequest({ adapter: fetchAdapter, baseURL })
    const err = await http.get('/404').catch((e) => e)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(404)
  })

  it('统一取消对自定义 adapter 同样生效：进行中 abort → kind=abort', async () => {
    const controller = new AbortController()
    const http = createRequest({ adapter: fetchAdapter, baseURL })
    const pending = http.get('/slow', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const err = await pending.catch((e) => e)
    expect(err.kind).toBe('abort')
  })
})
