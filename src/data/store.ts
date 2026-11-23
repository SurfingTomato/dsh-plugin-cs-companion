/**
 * 落盘：一个频道一个 JSON 文件，原子写。
 *
 * dsh 的 `ctx.storage` 需要额外挂载 backend 与 domain 包，对一个纯陪伴插件来说太重，
 * 所以这里直接用文件。目录默认 `~/.dsh/cs-companion/`，可以用 `dataDir` 配置改。
 * @module dsh-plugin-cs-companion/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 解析数据目录：优先配置，其次 `~/.dsh/cs-companion`。 */
export function resolveDataDir(configured?: string): string {
  const raw = (configured ?? '').trim()
  if (raw) return resolve(raw.replace(/^~(?=$|\/)/, homedir()))
  return join(homedir(), '.dsh', 'cs-companion')
}

/** 一份 JSON 文档的读写句柄。首次读之后常驻内存，写用 `tmp + rename` 保证不写坏。 */
export class JsonFile<T> {
  private readonly path: string
  private cache: T | null = null
  private dirty: Promise<void> | null = null

  constructor(dir: string, file: string) {
    this.path = join(dir, file)
  }

  /** 完整路径，报错信息里用得上。 */
  get location(): string {
    return this.path
  }

  /**
   * 读文档；不存在或内容坏了都返回 `fallback`，不让一个坏文件拖死插件。
   */
  async load(fallback: () => T): Promise<T> {
    if (this.cache) return this.cache
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(text) as T
      this.cache = parsed ?? fallback()
    } catch {
      this.cache = fallback()
    }
    return this.cache as T
  }

  /** 覆盖写。同一文件的并发写会串行化。 */
  async save(value: T): Promise<void> {
    this.cache = value
    const previous = this.dirty ?? Promise.resolve()
    this.dirty = previous
      .catch(() => undefined)
      .then(() => this.writeAtomic(value))
    await this.dirty
  }

  /** 读-改-写，改动函数直接改传进来的对象即可。 */
  async update(mutate: (value: T) => void | T): Promise<T> {
    const loaded = await this.loadFallback()
    const result = mutate(loaded)
    const next = (result === undefined ? loaded : result) as T
    await this.save(next)
    return next
  }

  private async loadFallback(): Promise<T> {
    if (this.cache) return this.cache
    // 没有 schema 的通用回退：空对象，调用方都按对象用。
    return this.load(() => ({} as T))
  }

  private async writeAtomic(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 1)}\n`, 'utf8')
    await rename(temp, this.path)
  }
}
