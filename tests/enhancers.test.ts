import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequest, createAbortError, defineAdapter, RequestError } from '../src'
import { withDedupe } from '../src/enhancers/dedupe'
import { withRetry } from '../src/enhancers/retry'
import { createUnwrapInterceptor } from '../src/interceptors'
import type {
  AdapterEnhancer,
  ChainableAdapter,
  RawResponse,
  RequestAdapter,
  RequestConfig,
} from '../src'

function rawResponse(overrides: Partial<RawResponse> = {}): RawResponse {
  return { status: 200, data: {}, headers: {}, ...overrides }
}

function createTestRequest(adapter: RequestAdapter) {
  const http = createRequest({ adapter, baseURL: 'https://api.example.com' })
  return { http, adapter: adapter as ReturnType<typeof vi.fn> }
}

describe('withRetry（adapter 装饰器）', () => {
  let adapter: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = vi.fn(async (): Promise<RawResponse> => rawResponse())
  })

  it('抛错后重试成功，重试响应走完整响应链', async () => {
    adapter
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(rawResponse({ data: { code: 0, data: 'payload' } }))
    const { http } = createTestRequest(withRetry(adapter as unknown as RequestAdapter))
    http.interceptors.response.use(createUnwrapInterceptor())
    const res = await http.get('/x')
    expect(res.data).toBe('payload') // 重试成功的响应正常剥壳
    expect(adapter).toHaveBeenCalledTimes(2)
  })

  it('非 2xx 默认不重试，交给 core 判 http 错误', async () => {
    adapter.mockResolvedValue(rawResponse({ status: 500 }))
    const { http } = createTestRequest(withRetry(adapter as unknown as RequestAdapter))
    const err = await http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.kind).toBe('http')
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('shouldRetry 可对非 2xx 开启重试（如 502）', async () => {
    adapter
      .mockResolvedValueOnce(rawResponse({ status: 502 }))
      .mockResolvedValueOnce(rawResponse({ status: 502 }))
      .mockResolvedValueOnce(rawResponse())
    const { http } = createTestRequest(
      withRetry(adapter as unknown as RequestAdapter, {
        shouldRetry: ({ response }) => response?.status === 502,
      }),
    )
    const res = await http.get('/x')
    expect(res.status).toBe(200)
    expect(adapter).toHaveBeenCalledTimes(3)
  })

  it('取消（AbortError）永不重试', async () => {
    adapter.mockRejectedValue(createAbortError())
    const { http } = createTestRequest(withRetry(adapter as unknown as RequestAdapter))
    const err = await http.get('/x').catch((e) => e)
    expect(err.kind).toBe('abort')
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('耗尽重试次数后抛出最后的错误', async () => {
    adapter.mockRejectedValue(new Error('still down'))
    const { http } = createTestRequest(
      withRetry(adapter as unknown as RequestAdapter, { retries: 1 }),
    )
    const err = await http.get('/x').catch((e) => e)
    expect(err.kind).toBe('network')
    expect(err.raw).toBeInstanceOf(Error)
    expect((err.raw as Error).message).toBe('still down')
    expect(adapter).toHaveBeenCalledTimes(2) // 首次 + 1 次重试
  })

  it('写方法默认不重试：POST 抛错只调一次（防重复扣款）', async () => {
    adapter.mockRejectedValue(new Error('response lost'))
    const { http } = createTestRequest(withRetry(adapter as unknown as RequestAdapter))
    const err = await http.post('/pay').catch((e) => e)
    expect(err.kind).toBe('network')
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('显式 shouldRetry 可对写方法开启重试（如已带幂等键）', async () => {
    adapter
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce(rawResponse({ data: { paid: true } }))
    const { http } = createTestRequest(
      withRetry(adapter as unknown as RequestAdapter, { shouldRetry: () => true }),
    )
    const res = await http.post('/pay', { idempotencyKey: 'k1' })
    expect(res.data).toEqual({ paid: true })
    expect(adapter).toHaveBeenCalledTimes(2)
  })
})

describe('withDedupe（adapter 装饰器）', () => {
  function createSlowAdapter() {
    let calls = 0
    const adapter: RequestAdapter = vi.fn(async (config: RequestConfig) => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return rawResponse({ data: { calls, url: config.url } })
    })
    return { adapter, calls: () => calls }
  }

  it('并发相同请求只发一次，共享同一结果', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(withDedupe(adapter))
    const [a, b] = await Promise.all([http.get('/same'), http.get('/same')])
    expect(calls()).toBe(1)
    expect(a.data).toEqual({ calls: 1, url: 'https://api.example.com/same' })
    expect(b.data).toEqual(a.data)
  })

  it('不同 key 各自发请求', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(withDedupe(adapter))
    await Promise.all([http.get('/a'), http.get('/b')])
    expect(calls()).toBe(2)
  })

  it('settle 后清理：后续同 url 请求重新发出', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(withDedupe(adapter))
    await http.get('/once')
    await http.get('/once')
    expect(calls()).toBe(2)
  })

  it('自定义 key（如按业务参数去重）', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(
      withDedupe(adapter, { key: (config) => String(config.url).split('?')[0] ?? '' }),
    )
    // params 不同但 key 相同 → 共享
    await Promise.all([http.get('/list', { params: { page: 1 } }), http.get('/list', { params: { page: 2 } })])
    expect(calls()).toBe(1)
  })

  it('写方法默认不去重：并发 POST 各自发出（+1 场景不丢操作）', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(withDedupe(adapter))
    await Promise.all([http.post('/plus1'), http.post('/plus1')])
    expect(calls()).toBe(2)
  })

  it('显式把 POST 加入去重范围：相同载荷的并发提交共享结果（防双击）', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(withDedupe(adapter, { methods: ['POST'] }))
    const [a, b] = await Promise.all([
      http.post('/submit', { sku: 1, qty: 1 }),
      http.post('/submit', { sku: 1, qty: 1 }),
    ])
    expect(calls()).toBe(1)
    expect(b.data).toEqual(a.data)
  })

  it('key 纳入 data：显式 POST 去重时不同载荷不合并', async () => {
    const { adapter, calls } = createSlowAdapter()
    const { http } = createTestRequest(withDedupe(adapter, { methods: ['POST'] }))
    await Promise.all([
      http.post('/submit', { sku: 1 }),
      http.post('/submit', { sku: 2 }),
    ])
    expect(calls()).toBe(2)
  })
})

describe('adapter 链式增强（.use）', () => {
  function makeChainableBase() {
    const order: string[] = []
    const base = defineAdapter(async () => {
      order.push('adapter')
      return rawResponse()
    })
    const first: AdapterEnhancer = (a) => async (config) => {
      order.push('first')
      return a(config)
    }
    const second: AdapterEnhancer = (a) => async (config) => {
      order.push('second')
      return a(config)
    }
    return { order, base, first, second }
  }

  it('注册顺序 = 请求流经顺序：.use(first).use(second) 依次经过 first → second → adapter', async () => {
    const { order, base, first, second } = makeChainableBase()
    const enhanced = base.use(first).use(second)
    await enhanced({ url: '/x' })
    expect(order).toEqual(['first', 'second', 'adapter'])
  })

  it('.use 不修改原 adapter（分支链互不影响）', async () => {
    const { order, base, first, second } = makeChainableBase()
    const branchA = base.use(first)
    const branchB = base.use(second)
    await branchA({ url: '/a' })
    await branchB({ url: '/b' })
    expect(order).toEqual(['first', 'adapter', 'second', 'adapter'])
  })

  it('链式组合等价嵌套：.use(withDedupe).use(withRetry) 时并发共享整个重试窗口', async () => {
    let calls = 0
    const flaky: RequestAdapter = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('flaky')
      return rawResponse({ data: { ok: 1 } })
    })
    const chainable: ChainableAdapter = defineAdapter(flaky)
    const { http } = createTestRequest(
      chainable.use(withDedupe()).use(withRetry({ retries: 3 })),
    )
    // 去重在外层先合并并发 → 重试只发生一轮（共 2 次 adapter 调用）
    const [a, b] = await Promise.all([http.get('/same'), http.get('/same')])
    expect(calls).toBe(2)
    expect(a.data).toEqual({ ok: 1 })
    expect(b.data).toEqual(a.data)
  })

  it('柯里形态可单独使用：withRetry(options)(adapter)', async () => {
    let calls = 0
    const flaky: RequestAdapter = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('flaky')
      return rawResponse()
    })
    const { http } = createTestRequest(withRetry({ retries: 2 })(flaky))
    const res = await http.get('/x')
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })
})

describe('extend（附加平台特有方法）', () => {
  it('工厂收到组合后的适配器：附加方法可路由完整管道（含 retry）', async () => {
    let calls = 0
    const flaky: RequestAdapter = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('flaky')
      return rawResponse({ data: { ok: 1 } })
    })
    const enhanced = defineAdapter(flaky)
      .use(withRetry({ methods: ['GET', 'POST'] }))
      .extend((request) => ({
        upload: (name: string) => request({ url: `/upload/${name}`, method: 'POST' }),
      }))
    const res = await enhanced.upload('a.png')
    expect(res.data).toEqual({ ok: 1 })
    expect(calls).toBe(2) // 附加方法走了 retry 管道
  })

  it('附加方法在 .use 链上保持不丢，且可继续叠加', async () => {
    const enhanced = defineAdapter(async () => rawResponse())
      .extend(() => ({ upload: () => 'u' as const, version: 1 }))
    const withDedupeChain = enhanced.use(withDedupe())
    expect(withDedupeChain.upload()).toBe('u')
    expect(withDedupeChain.version).toBe(1)
    const more = withDedupeChain.extend(() => ({ download: () => 'd' as const }))
    expect(more.upload()).toBe('u')
    expect(more.version).toBe(1)
    expect(more.download()).toBe('d')
  })

  it('extend 之前的装饰器作用于附加方法，之后的 .use 不影响已附加方法', async () => {
    let calls = 0
    const base = defineAdapter(async () => {
      calls++
      return rawResponse()
    })
    // extend 在 use 之前：工厂拿到的是"未带 dedupe 的组合"
    const extended = base.extend((request) => ({
      upload: () => request({ url: '/u', method: 'POST' }),
    }))
    const withDedupeChain = extended.use(withDedupe())
    await Promise.all([withDedupeChain.upload(), withDedupeChain.upload()])
    expect(calls).toBe(2) // 文档语义：先 use 后 extend，附加方法才享受装饰器
  })
})
