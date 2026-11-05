import { afterAll, describe, expect, it, vi } from 'vitest'
import { uniappAdapter } from '../src/adapters/uniapp'
import { createRequest } from '../src'

/**
 * uni-app 端无法在本机真跑，注入 fake globalThis.uni 模拟 uni.request 的回调行为。
 */
function setupUni() {
  const task = { abort: vi.fn() }
  let handlers: {
    success?: (res: { statusCode: number; data: unknown; header?: Record<string, string> }) => void
    fail?: (err: { errMsg?: string }) => void
  } = {}

  const request = vi.fn((options: {
    success?: typeof handlers.success
    fail?: typeof handlers.fail
  }) => {
    handlers = { success: options.success, fail: options.fail }
    return task
  })
  ;(globalThis as Record<string, unknown>).uni = { request }

  return {
    task,
    request,
    succeed: (res: {
      statusCode: number
      data?: unknown
      header?: Record<string, string>
    }) => handlers.success!({ data: {}, header: {}, ...res }),
    fail: (err: { errMsg?: string }) => handlers.fail!(err),
  }
}

afterAll(() => {
  delete (globalThis as Record<string, unknown>).uni
})

describe('uniappAdapter（fake globalThis.uni）', () => {
  it('success → resolve 统一 RawResponse，500 也原样 resolve（交给 core 判断）', async () => {
    const u = setupUni()
    const pending = uniappAdapter({ url: 'https://api.example.com/x' })
    u.succeed({
      statusCode: 500,
      data: { msg: 'server error' },
      header: { 'X-Trace': 't' },
    })
    const res = await pending
    expect(res.status).toBe(500)
    expect(res.data).toEqual({ msg: 'server error' })
    expect(res.headers).toEqual({ 'X-Trace': 't' })
  })

  it('headers → uni.request 的 header 字段映射', async () => {
    const u = setupUni()
    const pending = uniappAdapter({
      url: 'https://api.example.com/x',
      method: 'POST',
      data: { a: 1 },
      headers: { 'X-Token': 'abc' },
    })
    expect(u.request.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      data: { a: 1 },
      header: { 'X-Token': 'abc' },
    })
    u.succeed({ statusCode: 200 })
    await pending
  })

  it('fail（非 abort，如超时）→ 原样 reject，由 core 包装为 network', async () => {
    const u = setupUni()
    const pending = uniappAdapter({ url: 'https://api.example.com/x' }).catch(
      (e) => e,
    )
    u.fail({ errMsg: 'request:fail timeout' })
    const err = await pending
    expect(err).toMatchObject({ errMsg: 'request:fail timeout' })
    expect(err.name).not.toBe('AbortError')
  })

  it('fail（abort）→ 统一 AbortError', async () => {
    const u = setupUni()
    const pending = uniappAdapter({ url: 'https://api.example.com/x' }).catch(
      (e) => e,
    )
    u.fail({ errMsg: 'request:fail abort' })
    const err = await pending
    expect(err.name).toBe('AbortError')
  })

  it('入口已取消：不调 uni.request，直接 AbortError', async () => {
    const u = setupUni()
    const controller = new AbortController()
    controller.abort()
    const err = await uniappAdapter({
      url: 'https://api.example.com/x',
      signal: controller.signal,
    }).catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(u.request).not.toHaveBeenCalled()
  })

  it('进行中 abort → 调用 task.abort()，返回 AbortError', async () => {
    const u = setupUni()
    const controller = new AbortController()
    const pending = uniappAdapter({
      url: 'https://api.example.com/x',
      signal: controller.signal,
    }).catch((e) => e)
    controller.abort()
    const err = await pending
    expect(u.task.abort).toHaveBeenCalled()
    expect(err.name).toBe('AbortError')
  })

  it('settled 后摘除 abort 监听：成功后再 abort 不触发 task.abort（不泄漏）', async () => {
    const u = setupUni()
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = uniappAdapter({
      url: 'https://api.example.com/x',
      signal: controller.signal,
    })
    u.succeed({ statusCode: 200 })
    await pending
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(u.task.abort).not.toHaveBeenCalled()
  })

  it('core + uniappAdapter 整链：500 → RequestError(kind=http)', async () => {
    const u = setupUni()
    const http = createRequest({
      adapter: uniappAdapter,
      baseURL: 'https://api.example.com',
    })
    const pending = http.get('/x').catch((e) => e)
    u.succeed({ statusCode: 500, data: { msg: 'e' } })
    const err = await pending
    expect(err.kind).toBe('http')
    expect(err.status).toBe(500)
  })
})
