import { RequestError } from '../errors'
import type { ResponseInterceptor } from '../types'

export interface UnwrapInterceptorOptions {
  /** 业务成功码（后端常见字符串码，允许 string | number），默认 [0] */
  successCodes?: Array<string | number>
  /** 业务码字段名，默认 'code' */
  codeKey?: string
  /** 业务数据字段名，默认 'data' */
  dataKey?: string
  /** 业务消息字段名，默认 'message' */
  messageKey?: string
}

/**
 * 响应链拦截器：剥离 {code, data, message} 业务壳。
 * - body 非对象或缺 codeKey：视为非业务壳响应，原样放行（防御非 JSON 响应）
 * - 业务成功：res.data 替换为业务 data
 * - 业务失败：抛 RequestError(kind='business')，进入错误链
 */
export function createUnwrapInterceptor(
  options: UnwrapInterceptorOptions = {},
): ResponseInterceptor {
  const {
    successCodes = [0],
    codeKey = 'code',
    dataKey = 'data',
    messageKey = 'message',
  } = options

  return (res) => {
    const body = res.data as Record<string, unknown> | undefined
    if (typeof body !== 'object' || body === null || !(codeKey in body)) {
      return res
    }

    const code = body[codeKey]
    if (successCodes.includes(code as string | number)) {
      return { ...res, data: body[dataKey] }
    }

    throw new RequestError(
      'business',
      String(body[messageKey] || `Business error (code: ${String(code)})`),
      {
        status: res.status,
        data: body,
        config: res.config,
      },
    )
  }
}
