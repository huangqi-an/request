import { beforeEach, describe, expect, it, vi } from 'vitest'
// 从统一门面导入：门面含契约 + 零依赖插件（fetch/拦截器/装饰器），不含 axios/uniapp 适配器
import { buildUrl, createAbortError, createRequest, RequestError } from '../src'
import type {
  CreateRequestOptions,
  RawResponse,
  RequestAdapter,
  RequestConfig,
} from '../src'

function rawResponse(overrides: Partial<RawResponse> = {}): RawResponse {
  return { status: 200, data: {}, headers: {}, ...overrides }
}

function createTestRequest(
  handler: (config: RequestConfig) => Promise<RawResponse> = async () =>
    rawResponse(),
  options: Partial<CreateRequestOptions> = {},
) {
  const adapter: RequestAdapter = vi.fn(handler)
  const http = createRequest({
    adapter,
    baseURL: 'https://api.example.com',
    headers: { 'X-Common': '1' },
    timeout: 8000,
    ...options,
  })
  return { adapter: adapter as ReturnType<typeof vi.fn>, http }
}

describe('buildUrl', () => {
  it('拼接 baseURL 与 url，容错多余斜杠', () => {
    expect(buildUrl('https://api.example.com', '/users')).toBe(
      'https://api.example.com/users',
    )
    expect(buildUrl('https://api.example.com/', 'users')).toBe(
      'https://api.example.com/users',
    )
  })

  it('绝对 URL 忽略 baseURL', () => {
    expect(
      buildUrl('https://api.example.com', 'https://other.example.com/x'),
    ).toBe('https://other.example.com/x')
  })

  it('params 序列化：跳过 null/undefined，数组重复 key，encode 特殊字符', () => {
    expect(
      buildUrl(undefined, '/x', {
        a: 1,
        b: 'x y',
        c: null,
        d: undefined,
        e: [1, 2],
      }),
    ).toBe('/x?a=1&b=x%20y&e=1&e=2')
  })

  it('url 已带 ? 时用 & 追加；无有效 params 不加 ?', () => {
    expect(buildUrl(undefined, '/x?k=1', { a: 2 })).toBe('/x?k=1&a=2')
    expect(buildUrl(undefined, '/x', { a: null, b: undefined })).toBe('/x')
  })
})

describe('createRequest', () => {
  let ctx: ReturnType<typeof createTestRequest>

  beforeEach(() => {
    ctx = createTestRequest()
  })

  it('合并实例默认值，请求级配置优先；url 已拼好、params 已清空', async () => {
    await ctx.http.request({
      url: '/a',
      headers: { 'X-Request': '2' },
      timeout: 100,
    })
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.baseURL).toBe('https://api.example.com')
    expect(sent.timeout).toBe(100)
    expect(sent.headers).toEqual({ 'X-Common': '1', 'X-Request': '2' })
    expect(sent.method).toBe('GET')
    expect(sent.url).toBe('https://api.example.com/a')
    expect(sent.params).toBeUndefined()
  })

  it('请求拦截器按注册顺序执行，可注入 token', async () => {
    ctx.http.interceptors.request.use((config) => ({
      ...config,
      headers: { ...config.headers, 'X-A': 'a' },
    }))
    ctx.http.interceptors.request.use((config) => ({
      ...config,
      headers: { ...config.headers, 'X-B': 'b' },
    }))
    await ctx.http.get('/x')
    const sent = ctx.adapter.mock.calls[0]![0] as RequestConfig
    expect(sent.headers).toMatchObject({ 'X-A': 'a', 'X-B': 'b' })
  })

  it('2xx 正常返回 RawResponse，core 注入耗时与最终 config', async () => {
    ctx = createTestRequest(async () =>
      rawResponse({ status: 204, data: null, headers: { 'x-a': '1' } }),
    )
    const res = await ctx.http.get('/x')
    expect(res.status).toBe(204)
    expect(res.data).toBeNull()
    expect(res.headers).toEqual({ 'x-a': '1' })
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    expect(res.config?.url).toBe('https://api.example.com/x')
  })

  it('非 2xx 抛 RequestError(kind=http)，携带 status/data/headers', async () => {
    ctx = createTestRequest(async () =>
      rawResponse({ status: 404, data: { msg: 'not found' } }),
    )
    const err = await ctx.http.get('/missing').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(404)
    expect(err.data).toEqual({ msg: 'not found' })
  })

  it('adapter 抛普通错误 → kind=network，raw 保留原始错误', async () => {
    const boom = new Error('socket hang up')
    ctx = createTestRequest(async () => {
      throw boom
    })
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('network')
    expect(err.raw).toBe(boom)
  })

  it('signal 已取消时不发请求，直接 kind=abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const err = await ctx.http
      .get('/x', { signal: controller.signal })
      .catch((e) => e)
    expect(err.kind).toBe('abort')
    expect(ctx.adapter).not.toHaveBeenCalled()
  })

  it('adapter 抛 AbortError（如请求中被取消）→ kind=abort', async () => {
    ctx = createTestRequest(async () => {
      throw createAbortError()
    })
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err.kind).toBe('abort')
  })

  it('响应拦截器可剥壳转换', async () => {
    ctx = createTestRequest(async () =>
      rawResponse({ data: { code: 0, data: { id: 1 } } }),
    )
    ctx.http.interceptors.response.use((res) => ({
      ...res,
      data: (res.data as { data: { id: number } }).data,
    }))
    const res = await ctx.http.get<{ id: number }>('/x')
    expect(res.data).toEqual({ id: 1 })
  })

  it('错误链：返回 RawResponse 视为恢复，直接作为最终结果', async () => {
    ctx = createTestRequest(async () => rawResponse({ status: 404 }))
    ctx.http.interceptors.error.use(() =>
      rawResponse({ status: 200, data: 'fallback' }),
    )
    const res = await ctx.http.get('/x')
    expect(res.data).toBe('fallback')
  })

  it('错误链：返回或抛出 RequestError 可替换错误', async () => {
    ctx = createTestRequest(async () => rawResponse({ status: 401 }))
    ctx.http.interceptors.error.use(() => new RequestError('http', '未登录'))
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.message).toBe('未登录')
  })

  it('错误链：无返回值 = 放行，观察者执行后错误继续抛给业务方', async () => {
    ctx = createTestRequest(async () => rawResponse({ status: 500 }))
    const observer = vi.fn()
    ctx.http.interceptors.error.use(observer)
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(500)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer.mock.calls[0]![0]).toBeInstanceOf(RequestError)
  })

  it('错误链：按注册顺序执行，恢复后不再执行后续拦截器', async () => {
    ctx = createTestRequest(async () => rawResponse({ status: 404 }))
    const order: string[] = []
    ctx.http.interceptors.error.use(() => {
      order.push('observer')
    })
    ctx.http.interceptors.error.use(() => {
      order.push('recovery')
      return rawResponse({ status: 200, data: 'ok' })
    })
    ctx.http.interceptors.error.use(() => {
      order.push('never')
    })
    const res = await ctx.http.get('/x')
    expect(res.data).toBe('ok')
    expect(order).toEqual(['observer', 'recovery'])
  })

  it('错误链：响应成功链抛出的错误也进入错误链', async () => {
    ctx.http.interceptors.response.use(() => {
      throw new Error('boom in transformer')
    })
    const seen: RequestError[] = []
    ctx.http.interceptors.error.use((err) => {
      seen.push(err)
    })
    const err = await ctx.http.get('/x').catch((e) => e)
    expect(err.message).toBe('boom in transformer')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(RequestError)
    expect(seen[0]!.kind).toBe('network')
  })

  it('快捷方法 get/post/put/patch/delete 的 method 与 data 正确', async () => {
    await ctx.http.post('/a', { x: 1 })
    await ctx.http.put('/b', { y: 2 })
    await ctx.http.patch('/d', { z: 3 })
    await ctx.http.delete('/c')
    const calls = ctx.adapter.mock.calls as unknown as RequestConfig[][]
    expect(calls[0]![0]).toMatchObject({ url: 'https://api.example.com/a', method: 'POST', data: { x: 1 } })
    expect(calls[1]![0]).toMatchObject({ url: 'https://api.example.com/b', method: 'PUT', data: { y: 2 } })
    expect(calls[2]![0]).toMatchObject({ url: 'https://api.example.com/d', method: 'PATCH', data: { z: 3 } })
    expect(calls[3]![0]).toMatchObject({ url: 'https://api.example.com/c', method: 'DELETE' })
  })
})
