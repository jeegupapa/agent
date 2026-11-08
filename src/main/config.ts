import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_CONFIG,
  DEFAULT_FIREBASE_SETTINGS,
  DEFAULT_UPDATE_CONFIG,
  type AppConfig,
  type AppConfigView
} from '../shared/types'

/**
 * 앱 설정은 userData/config.json 에 평문 JSON 으로,
 * API 키는 userData/apikey.bin 에 OS 자격 증명 저장소(DPAPI) 로 암호화해 둔다.
 */
export class ConfigStore {
  private dir = app.getPath('userData')
  private configPath = join(this.dir, 'config.json')
  private keyPath = join(this.dir, 'apikey.bin')
  private ghTokenPath = join(this.dir, 'ghtoken.bin')

  load(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<AppConfig>
        return {
          ...DEFAULT_CONFIG,
          ...raw,
          auth: { ...DEFAULT_CONFIG.auth, ...(raw.auth ?? {}) },
          mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
          update: { ...DEFAULT_UPDATE_CONFIG, ...(raw.update ?? {}) },
          firebase: { ...DEFAULT_FIREBASE_SETTINGS, ...(raw.firebase ?? {}) }
        }
      }
    } catch (err) {
      console.error('config.json 읽기 실패:', err)
    }
    return structuredClone(DEFAULT_CONFIG)
  }

  save(config: AppConfig): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8')
  }

  view(): AppConfigView {
    const key = this.getApiKey()
    return {
      ...this.load(),
      hasApiKey: key !== null,
      apiKeyHint: key ? key.slice(-4) : undefined,
      hasUpdateToken: this.getUpdateToken() !== null
    }
  }

  /** 비공개 GitHub 저장소에서 업데이트를 받을 때 쓰는 토큰 (DPAPI 암호화) */
  getUpdateToken(): string | null {
    return this.readSecret(this.ghTokenPath)
  }

  setUpdateToken(token: string | null): void {
    this.writeSecret(this.ghTokenPath, token)
  }

  private readSecret(path: string): string | null {
    try {
      if (!existsSync(path)) return null
      const buf = readFileSync(path)
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
      return buf.toString('utf8')
    } catch (err) {
      console.error('비밀값 복호화 실패:', path, err)
      return null
    }
  }

  private writeSecret(path: string, value: string | null): void {
    mkdirSync(this.dir, { recursive: true })
    if (!value) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8')
    writeFileSync(path, data)
  }

  getApiKey(): string | null {
    try {
      if (!existsSync(this.keyPath)) return null
      const buf = readFileSync(this.keyPath)
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
      return buf.toString('utf8')
    } catch (err) {
      console.error('API 키 복호화 실패:', err)
      return null
    }
  }

  setApiKey(key: string | null): void {
    mkdirSync(this.dir, { recursive: true })
    if (!key) {
      if (existsSync(this.keyPath)) unlinkSync(this.keyPath)
      return
    }
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, 'utf8')
    writeFileSync(this.keyPath, data)
  }
}
