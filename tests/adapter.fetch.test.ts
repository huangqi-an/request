import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequest, RequestError } from '../src'
import type { RequestProgress } from '../src'
import { fetchAdapter } from '../src/adapters/fetch'

let server: Server
let baseURL: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const respond = (status: number, headers: Record<string, string>, body: string) => {
      res.writeHead(status, headers)
      res.end(body)
    }
    // 永不响应的路由：留给"进行中取消 / 超时"的用例
    if (req.url === '/slow') return
    if (req.url === '/404') {
      respond(404, { 'Content-Type': 'application/json' }, JSON.stringify({ msg: 'not found' }))
      return
    }
    if (req.url === '/text') {
      respond(200, { 'Content-Type': 'text/plain' }, 'plain-text-body')
      return
    }
    if (req.url === '/download') {
      const body = 'x'.repeat(1000)
      respond(
        200,
        { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
        body,
      )
      return
    }
    if (req.url === '/chunked') {
      // 不设 Content-Length → chunked 传输，下载进度无 total
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('hello-')
      res.end('world')
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(301, { Location: '/echo' })
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      respond(
        200,
        { 'Content-Type': 'application/json' },
        JSON.stringify({
          method: req.method,
          url: req.url,
          body: raw,
          contentType: req.headers['content-type'] ?? null,
        }),
      )
    })
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

describe('fetchAdapter（全局 fetch → 本地 http server）', () => {
  it('返回统一 RawResponse 形状，JSON 自动解析', async () => {
    const res = await fetchAdapter({ url: `${baseURL}/echo?a=1`, method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.data).toMatchObject({ method: 'GET', url: '/echo?a=1' })
  })

  it('core 整链：404 → kind=http', async () => {
    const http = createRequest({ adapter: fetchAdapter, baseURL })
    const err = await http.get('/404').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(404)
    expect(err.data).toEqual({ msg: 'not found' })
  })

  it('对象 body 自动 JSON 序列化并补 Content-Type', async () => {
    const res = await fetchAdapter({ url: `${baseURL}/echo`, method: 'POST', data: { a: 1 } })
    const data = res.data as { body: string; contentType: string | null }
    expect(JSON.parse(data.body)).toEqual({ a: 1 })
    expect(data.contentType).toBe('application/json')
  })

  it('字符串 body 原样发送，不改动 Content-Type', async () => {
    const res = await fetchAdapter({
      url: `${baseURL}/echo`,
      method: 'POST',
      data: 'raw-text',
      headers: { 'Content-Type': 'text/plain' },
    })
    const data = res.data as { body: string; contentType: string | null }
    expect(data.body).toBe('raw-text')
    expect(data.contentType).toBe('text/plain')
  })

  it('GET 忽略 data（fetch 不允许 GET 携带 body）', async () => {
    const res = await fetchAdapter({
      url: `${baseURL}/echo`,
      method: 'GET',
      data: { ignored: true },
    })
    const data = res.data as { body: string }
    expect(data.body).toBe('')
  })

  it('非 JSON 响应保留文本', async () => {
    const res = await fetchAdapter({ url: `${baseURL}/text` })
    expect(res.data).toBe('plain-text-body')
  })

  it('进行中 abort → kind=abort', async () => {
    const controller = new AbortController()
    const http = createRequest({ adapter: fetchAdapter, baseURL })
    const pending = http.get('/slow', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const err = await pending.catch((e) => e)
    expect(err.kind).toBe('abort')
  })

  it('timeout → kind=network（与 axios/uni 的超时归类一致）', async () => {
    const http = createRequest({ adapter: fetchAdapter, baseURL })
    const err = await http.get('/slow', { timeout: 50 }).catch((e) => e)
    expect(err.kind).toBe('network')
    expect(err.message).toContain('timed out')
  })

  it('下载进度：流式读取，Content-Length 已知时带 total/progress', async () => {
    const events: RequestProgress[] = []
    const res = await fetchAdapter({
      url: `${baseURL}/download`,
      on: { downloadProgress: (p) => events.push(p) },
    })
    expect(res.data).toBe('x'.repeat(1000))
    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]!
    expect(last.total).toBe(1000)
    expect(last.loaded).toBe(1000)
    expect(last.progress).toBe(1)
  })

  it('下载进度：chunked 无 Content-Length 时 total/progress 为 undefined', async () => {
    const events: RequestProgress[] = []
    const res = await fetchAdapter({
      url: `${baseURL}/chunked`,
      on: { downloadProgress: (p) => events.push(p) },
    })
    expect(res.data).toBe('hello-world')
    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]!
    expect(last.loaded).toBe(11)
    expect(last.total).toBeUndefined()
    expect(last.progress).toBeUndefined()
  })

  it('adapterOptions 透传：redirect: manual 生效（默认会跟随重定向）', async () => {
    // 对照：默认跟随重定向，最终落在 /echo
    const followed = await fetchAdapter({ url: `${baseURL}/redirect` })
    expect(followed.status).toBe(200)
    // redirect: 'manual' 透传给 fetch → 拿到 opaque redirect（status 0），不跟随
    const manual = await fetchAdapter({
      url: `${baseURL}/redirect`,
      adapterOptions: { fetch: { redirect: 'manual' } },
    })
    expect(manual.status).not.toBe(200)
  })
})
