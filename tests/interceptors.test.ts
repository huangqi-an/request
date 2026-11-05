import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequest, RequestError } from '../src'
import {
  createAuthInterceptor,
  createLoggerInterceptors,
  createRequestIdInterceptor,
  createUnwrapInterceptor,
} from '../src/interceptors'
import { withRetry } from '../src/enhancers/retry'
import type { RawResponse, RequestAdapter, RequestConfig } from '../src'

function rawResponse(overrides: Partial<RawResponse> = {}): RawResponse {
  return { status: 200, data: {}, headers: {}, ...overrides }
}

function createTestRequest(
  handler: (config: RequestConfig) => Promise<RawResponse> = async () =>
    rawResponse(),
) {
  const adapter: RequestAdapter = vi.fn(handler)
  const http = createRequest({ adapter, baseURL: 'https://api.example.com' })
  return { adapter: adapter as ReturnType<typeof vi.fn>, http }
}

describe('auth 拦截器', () => {
  let ctx: ReturnType<typeof createTestRequest>

  beforeEach(() => {
    ctx = createTestRequest()
  })

  it('注入默认 Authorization: Bearer <token>', async () => {
    ctx.http.interceptors.request.use(createAuthInterceptor({ getToken: () => 'tk-1' }))
    await ctx.http.get('/x')
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ Authorization: 'Bearer tk-1' })
  })

  it('getToken 支持异步', async () => {
    ctx.http.interceptors.request.use(
      createAuthInterceptor({ getToken: async () => 'async-token' }),
    )
    await ctx.http.get('/x')
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ Authorization: 'Bearer async-token' })
  })

  it('getToken 返回空值则跳过注入', async () => {
    ctx.http.interceptors.request.use(createAuthInterceptor({ getToken: () => undefined }))
    await ctx.http.get('/x')
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).not.toHaveProperty('Authorization')
  })

  it('shouldAttach 返回 false 的请求不注入', async () => {
    ctx.http.interceptors.request.use(
      createAuthInterceptor({
        getToken: () => 'tk',
        shouldAttach: (config) => !config.url.includes('/login'),
      }),
    )
    await ctx.http.get('/login')
    await ctx.http.get('/users')
    const calls = ctx.adapter.mock.calls as unknown as RequestConfig[][]
    expect(calls[0]![0]!.headers).not.toHaveProperty('Authorization')
    expect(calls[1]![0]!.headers).toMatchObject({ Authorization: 'Bearer tk' })
  })

  it('自定义头名与前缀', async () => {
    ctx.http.interceptors.request.use(
      createAuthInterceptor({ getToken: () => 'tk', headerName: 'X-Token', scheme: '' }),
    )
    await ctx.http.get('/x')
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ 'X-Token': 'tk' })
  })
})

describe('unwrap 拦截器', () => {
  let ctx: ReturnType<typeof createTestRequest>

  beforeEach(() => {
    ctx = createTestRequest()
  })

  it('业务成功：剥离外壳，data 替换为业务数据', async () => {
    ctx = createTestRequest(async () =>
      rawResponse({ data: { code: 0, data: { id: 1 }, message: 'ok' } }),
    )
    ctx.http.interceptors.response.use(createUnwrapInterceptor())
    const res = await ctx.http.get<{ id: number }>('/x')
    expect(res.data).toEqual({ id: 1 })
  })

  it('业务失败：抛 kind=business 的 RequestError，携带业务数据', async () => {
    ctx = createTestRequest(async () =>
      rawResponse({ data: { code: 1001, data: null, message: '参数错误' } }),
    )
    ctx.http.interceptors.response.use(createUnwrapInterceptor())
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('business')
    expect(err.status).toBe(200)
    expect(err.message).toBe('参数错误')
    expect(err.data).toEqual({ code: 1001, data: null, message: '参数错误' })
  })

  it('非对象 body 原样放行', async () => {
    ctx = createTestRequest(async () => rawResponse({ data: 'plain text' }))
    ctx.http.interceptors.response.use(createUnwrapInterceptor())
    const res = await ctx.http.get('/x')
    expect(res.data).toBe('plain text')
  })

  it('缺业务码字段的 body 原样放行', async () => {
    ctx = createTestRequest(async () => rawResponse({ data: { foo: 1 } }))
    ctx.http.interceptors.response.use(createUnwrapInterceptor())
    const res = await ctx.http.get('/x')
    expect(res.data).toEqual({ foo: 1 })
  })

  it('自定义键名与成功码（含字符串码）', async () => {
    ctx = createTestRequest(async () =>
      rawResponse({ data: { status: 'ok', result: { id: 2 } } }),
    )
    ctx.http.interceptors.response.use(
      createUnwrapInterceptor({
        successCodes: ['ok'],
        codeKey: 'status',
        dataKey: 'result',
      }),
    )
    const res = await ctx.http.get<{ id: number }>('/x')
    expect(res.data).toEqual({ id: 2 })
  })
})

describe('logger 拦截器', () => {
  it('三条链都输出日志，响应含耗时与 url', async () => {
    const log = vi.fn()
    const { http, adapter } = createTestRequest(async () =>
      rawResponse({ data: { ok: 1 } }),
    )
    const logger = createLoggerInterceptors({ log })
    http.interceptors.request.use(logger.request)
    http.interceptors.response.use(logger.response)
    http.interceptors.error.use(logger.error)

    const res = await http.get('/x', { params: { a: 1 } })

    // core 注入的耗时与 config
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    expect(res.config?.url).toBe('https://api.example.com/x?a=1')

    const calls = log.mock.calls as Array<[string, ...unknown[]]>
    const requestLog = calls.find((c) => c[1] === '[request]')
    expect(requestLog).toBeDefined()
    expect(requestLog).toEqual(['debug', '[request]', 'GET', '/x', { a: 1 }])

    const responseLog = calls.find((c) => c[1] === '[response]')
    expect(responseLog).toBeDefined()
    expect(responseLog![2]).toBe(200)
    expect(String(responseLog![3])).toMatch(/^\d+ms$/)
    expect(responseLog![4]).toBe('https://api.example.com/x?a=1')
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('失败走 error 链日志（kind + message + url）', async () => {
    const log = vi.fn()
    const { http } = createTestRequest(async () => rawResponse({ status: 500 }))
    const logger = createLoggerInterceptors({ log })
    http.interceptors.request.use(logger.request)
    http.interceptors.response.use(logger.response)
    http.interceptors.error.use(logger.error)

    await http.get('/broken').catch(() => {})

    const calls = log.mock.calls as Array<[string, ...unknown[]]>
    const errorLog = calls.find((c) => c[1] === '[error]')
    expect(errorLog).toBeDefined()
    expect(errorLog![0]).toBe('warn')
    expect(errorLog![2]).toBe('http')
    expect(errorLog![3]).toContain('500')
    expect(errorLog![4]).toBe('https://api.example.com/broken')
  })
})

describe('requestId 拦截器', () => {
  let ctx: ReturnType<typeof createTestRequest>

  beforeEach(() => {
    ctx = createTestRequest()
  })

  it('每个请求注入唯一 ID（默认头名 X-Request-Id）', async () => {
    ctx.http.interceptors.request.use(createRequestIdInterceptor())
    await ctx.http.get('/a')
    await ctx.http.get('/b')
    const calls = ctx.adapter.mock.calls as unknown as RequestConfig[][]
    const id1 = calls[0]![0]!.headers?.['X-Request-Id']
    const id2 = calls[1]![0]!.headers?.['X-Request-Id']
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })

  it('自定义头名与 ID 生成器', async () => {
    ctx.http.interceptors.request.use(
      createRequestIdInterceptor({ headerName: 'X-Trace-Id', generateId: () => 'fixed-trace' }),
    )
    await ctx.http.get('/x')
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ 'X-Trace-Id': 'fixed-trace' })
    expect(sent.headers).not.toHaveProperty('X-Request-Id')
  })

  it('默认覆盖已存在的头；keepExisting 开启时保留上游透传的 ID', async () => {
    ctx.http.interceptors.request.use(createRequestIdInterceptor({ generateId: () => 'new-id' }))
    await ctx.http.get('/x', { headers: { 'X-Request-Id': 'upstream-id' } })
    let sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ 'X-Request-Id': 'new-id' })

    ctx = createTestRequest()
    ctx.http.interceptors.request.use(
      createRequestIdInterceptor({ generateId: () => 'new-id', keepExisting: true }),
    )
    await ctx.http.get('/x', { headers: { 'X-Request-Id': 'upstream-id' } })
    sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ 'X-Request-Id': 'upstream-id' })
  })

  it('重试共享同一 ID：同一次逻辑请求（含重试）服务端可识别重发', async () => {
    let calls = 0
    const ids: Array<string | undefined> = []
    const adapter: RequestAdapter = vi.fn(async (config: RequestConfig) => {
      calls++
      ids.push(config.headers?.['X-Request-Id'])
      if (calls === 1) throw new Error('flaky')
      return rawResponse()
    })
    const http2 = createRequest({
      adapter: withRetry(adapter),
      baseURL: 'https://api.example.com',
    })
    http2.interceptors.request.use(createRequestIdInterceptor())
    const res = await http2.get('/x')
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).toBe(ids[1])
  })

  it('失败时错误链可从 err.config 取到请求 ID', async () => {
    ctx = createTestRequest(async () => rawResponse({ status: 500 }))
    ctx.http.interceptors.request.use(createRequestIdInterceptor())
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('http')
    expect(err.config.headers['X-Request-Id']).toBeTruthy()
  })
})
