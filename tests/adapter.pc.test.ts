import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pcAdapter } from '../src/adapters/pc'
import { createRequest } from '../src'

let server: Server
let baseURL: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Echo': 'yes',
      })
      res.end(JSON.stringify(body))
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

describe('pcAdapter（真实 axios → 本地 http server）', () => {
  it('返回统一 RawResponse 形状（status/data/headers）', async () => {
    const res = await pcAdapter({ url: `${baseURL}/echo?a=1`, method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers['x-echo']).toBe('yes')
    expect(res.data).toMatchObject({ method: 'GET', url: '/echo?a=1' })
  })

  it('validateStatus: () => true 生效：404 也 resolve 而不是抛错', async () => {
    const res = await pcAdapter({ url: `${baseURL}/404` })
    expect(res.status).toBe(404)
    expect(res.data).toEqual({ msg: 'not found' })
  })

  it('POST body 与 Content-Type 透传', async () => {
    const res = await pcAdapter({
      url: `${baseURL}/echo`,
      method: 'POST',
      data: { a: 1 },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.data).toMatchObject({ body: { a: 1 } })
  })

  it('core + pcAdapter 整链：404 → RequestError(kind=http)', async () => {
    const http = createRequest({ adapter: pcAdapter, baseURL })
    const err = await http.get('/404').catch((e) => e)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(404)
    expect(err.data).toEqual({ msg: 'not found' })
  })

  it('进行中 abort → core 得到 kind=abort', async () => {
    const controller = new AbortController()
    const http = createRequest({ adapter: pcAdapter, baseURL })
    const pending = http.get('/slow', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const err = await pending.catch((e) => e)
    expect(err.kind).toBe('abort')
  })
})
