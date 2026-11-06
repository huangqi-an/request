import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { axiosAdapter } from '../src/adapters/axios'
import { createRequest } from '../src'

let server: Server
let baseURL: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Echo': 'yes',
        'Content-Length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }

    // 永不响应的路由：留给"进行中取消"的用例
    if (req.url === '/slow') return

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (req.url === '/404') {
        respond(404, { msg: 'not found' })
        return
      }
      respond(200, {
        method: req.method,
        url: req.url,
        body: raw ? JSON.parse(raw) : null,
      })
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

describe('axiosAdapter（真实 axios → 本地 http server）', () => {
  it('返回统一 RawResponse 形状（status/data/headers）', async () => {
    const res = await axiosAdapter({ url: `${baseURL}/echo?a=1`, method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers['x-echo']).toBe('yes')
    expect(res.data).toMatchObject({ method: 'GET', url: '/echo?a=1' })
  })

  it('validateStatus: () => true 生效：404 也 resolve 而不是抛错', async () => {
    const res = await axiosAdapter({ url: `${baseURL}/404` })
    expect(res.status).toBe(404)
    expect(res.data).toEqual({ msg: 'not found' })
  })

  it('POST body 与 Content-Type 透传', async () => {
    const res = await axiosAdapter({
      url: `${baseURL}/echo`,
      method: 'POST',
      data: { a: 1 },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.data).toMatchObject({ body: { a: 1 } })
  })

  it('core + axiosAdapter 整链：404 → RequestError(kind=http)', async () => {
    const http = createRequest({ adapter: axiosAdapter, baseURL })
    const err = await http.get('/404').catch((e) => e)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(404)
    expect(err.data).toEqual({ msg: 'not found' })
  })

  it('进行中 abort → core 得到 kind=abort', async () => {
    const controller = new AbortController()
    const http = createRequest({ adapter: axiosAdapter, baseURL })
    const pending = http.get('/slow', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const err = await pending.catch((e) => e)
    expect(err.kind).toBe('abort')
  })

  it('进度回调：Node 适配器同样触发（axios 1.x 支持流式进度），事件归一化', async () => {
    const on = { uploadProgress: vi.fn(), downloadProgress: vi.fn() }
    const res = await axiosAdapter({
      url: `${baseURL}/echo`,
      method: 'POST',
      data: { a: 1 },
      on,
    })
    expect(res.status).toBe(200)
    // 上传：请求体 {"a":1} 共 7 字节，写完时到达 100%
    expect(on.uploadProgress).toHaveBeenCalledWith({ loaded: 7, total: 7, progress: 1 })
    // 下载：末个事件到达 100%
    const downloadCalls = on.downloadProgress.mock.calls as Array<
      [{ loaded: number; total?: number; progress?: number }]
    >
    const last = downloadCalls[downloadCalls.length - 1]![0]
    expect(last.progress).toBe(1)
    expect(last.loaded).toBe(last.total)
  })

  it('adapterOptions 透传：axios 的 adapter 参数生效（如切换 fetch 适配器）', async () => {
    const res = await axiosAdapter({
      url: `${baseURL}/echo?a=1`,
      method: 'GET',
      adapterOptions: { axios: { adapter: 'fetch' } },
    })
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ url: '/echo?a=1' })
  })

  it('adapterOptions 冲突规则：透传项覆盖不了契约派生字段', async () => {
    const res = await axiosAdapter({
      url: `${baseURL}/echo`,
      method: 'GET',
      adapterOptions: {
        axios: {
          url: 'https://evil.example.com/steal',
          validateStatus: (status: number) => status === 500,
        },
      },
    })
    // 仍请求契约里的 url，且 200 仍 resolve（validateStatus 未被透传覆盖）
    expect(res.status).toBe(200)
    expect((res.data as { url: string }).url).toBe('/echo')
  })
})
