/**
 * 极薄的 HTTP 封装：只要 JSON，超时、重试、UA 三件事明确写在这里。
 *
 * Node 18+ 自带 fetch，解压交给 undici（gzip 自动处理），所以没有额外依赖。
 * @module dsh-plugin-cs-companion/http
 */

/** 带稳定 code 的错误，方便工具层区分"取不到"和"写错了"。 */
export class DataError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DataError'
    this.code = code
  }
}

export interface FetchJsonOptions {
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
  /** 总尝试次数，含第一次。默认 3。 */
  readonly attempts?: number
  readonly signal?: AbortSignal
  /** 429/503 时是否重试；Liquipedia 条款要求不重试，所以默认 true 但可关。 */
  readonly retryOnRateLimit?: boolean
  readonly label?: string
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/**
 * 取一个 JSON 文档。
 * @param url 完整 URL，查询参数由调用方拼好。
 * @param options 超时、重试与请求头。
 * @returns 解析后的 JSON，类型由调用方断言。
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const timeoutMs = options.timeoutMs ?? 12_000
  const label = options.label ?? 'remote'
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout
      const response = await fetch(url, {
        signal,
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          ...options.headers,
        },
      })
      if (response.status === 429 || response.status >= 500) {
        const retryable = response.status !== 429 || options.retryOnRateLimit !== false
        if (!retryable || attempt === attempts) {
          throw new DataError(
            'UPSTREAM_STATUS',
            `${label} 返回 ${response.status}`,
          )
        }
        await sleep(600 * attempt)
        continue
      }
      if (!response.ok) {
        throw new DataError('UPSTREAM_STATUS', `${label} 返回 ${response.status}`)
      }
      const text = await response.text()
      try {
        return JSON.parse(text) as T
      } catch {
        throw new DataError(
          'UPSTREAM_BODY',
          `${label} 返回的不是 JSON（前 80 字：${text.slice(0, 80)}）`,
        )
      }
    } catch (error) {
      lastError = error
      if (error instanceof DataError && error.code === 'UPSTREAM_BODY') throw error
      if (options.signal?.aborted) throw error
      if (attempt === attempts) break
      await sleep(400 * attempt)
    }
  }

  if (lastError instanceof DataError) throw lastError
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new DataError('UPSTREAM_UNREACHABLE', `${label} 取不到（${reason}）`)
}

/** 等待若干毫秒；被中断时不抛异常，交给调用方的 signal 处理。 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
