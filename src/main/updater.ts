import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import log from 'electron-log/main'
import type { UpdateConfig, UpdateStatus } from '../shared/types'

/** package.json build.publish 에 들어 있는 자리표시자. 이 값이면 "배포 주소 미설정"으로 본다 */
const PLACEHOLDER_HOST = 'example.invalid'
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** electron-updater 오류를 사람이 읽을 문장으로. 응답 헤더 덤프는 버린다 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const first = raw.split('\n')[0].trim()
  if (/releases\.atom|api\.github\.com|github\.com\/.*\/releases/.test(raw) && /\b(404|401|403)\b/.test(first)) {
    return 'GitHub 에서 Release 를 읽지 못했습니다 (' + (/\b(\d{3})\b/.exec(first)?.[1] ?? '오류') +
      '). 저장소가 비공개이면 설정 → 업데이트 → "GitHub 토큰" 에 저장소 읽기 권한이 있는 토큰을 넣거나, 저장소를 공개로 바꾸세요. Release 가 아직 없을 때도 같은 오류가 납니다.'
  }
  if (/github\.com|releases\.atom|api\.github\.com/.test(raw) && /\b(5\d\d)\b/.test(first)) {
    return 'GitHub 서버가 일시적으로 응답하지 않습니다 (' + (/\b(5\d\d)\b/.exec(first)?.[1] ?? '5xx') +
      '). 설정 문제가 아니라 GitHub 쪽 장애이므로 잠시 후 "지금 확인"을 다시 눌러 주세요. 자동 확인은 4시간마다 다시 시도합니다.'
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/.test(raw)) {
    return '업데이트 서버에 연결하지 못했습니다. 네트워크와 배포 위치를 확인하세요. (' + first.slice(0, 120) + ')'
  }
  if (/sha512|checksum/i.test(raw)) return '내려받은 파일의 체크섬이 맞지 않습니다. 다시 확인해 보세요.'
  return first.length > 300 ? first.slice(0, 300) + '…' : first
}

type FeedOptions =
  | { provider: 'generic'; url: string }
  | { provider: 'github'; owner: string; repo: string; token?: string; private?: boolean }

function releaseNotesText(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes
  if (!n) return undefined
  if (typeof n === 'string') return n
  return n.map((x) => (x.note ? `${x.version}\n${x.note}` : x.version)).join('\n\n')
}

/**
 * electron-updater 래퍼.
 * - 설정(UpdateConfig)에 따라 피드 URL·자동 다운로드·종료 시 설치를 적용하고
 * - 상태 변화를 렌더러에 `update:status` 로 밀어 준다.
 */
export class AppUpdater {
  private status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }
  private timer: NodeJS.Timeout | null = null
  private config: UpdateConfig

  constructor(
    private win: BrowserWindow,
    private getConfig: () => UpdateConfig,
    /** 비공개 GitHub 저장소용 토큰 (없으면 null) */
    private getToken: () => string | null = () => null
  ) {
    this.config = getConfig()
    log.initialize()
    log.transports.file.level = 'info'
    autoUpdater.logger = log
    autoUpdater.autoInstallOnAppQuit = this.config.installOnQuit
    autoUpdater.autoDownload = this.config.autoDownload
    autoUpdater.allowDowngrade = false
    autoUpdater.disableWebInstaller = true
    // 개발 모드(electron-vite dev)에서도 피드만 지정되면 확인 동작을 테스트할 수 있게 한다
    autoUpdater.forceDevUpdateConfig = !app.isPackaged

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.set({
        state: this.config.autoDownload ? 'downloading' : 'available',
        version: info.version,
        releaseNotes: releaseNotesText(info),
        releaseDate: info.releaseDate,
        percent: 0,
        checkedAt: Date.now(),
        error: undefined
      })
    )
    autoUpdater.on('update-not-available', (info) =>
      this.set({ state: 'not-available', version: info.version, checkedAt: Date.now(), error: undefined })
    )
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set({
        state: 'downloading',
        percent: p.percent,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ state: 'downloaded', version: info.version, percent: 100, releaseNotes: releaseNotesText(info) })
    )
    autoUpdater.on('error', (err) => {
      log.error('autoUpdater error', err)
      this.set({ state: 'error', error: friendlyError(err) })
    })

    this.applyConfig(this.config)
  }

  /** 설정 저장 시 호출: 피드·플래그를 다시 적용하고 주기 확인을 켜거나 끈다 */
  applyConfig(config: UpdateConfig): void {
    this.config = config
    autoUpdater.autoDownload = config.autoDownload
    autoUpdater.autoInstallOnAppQuit = config.installOnQuit

    const feed = this.feedOptions(config)
    if (feed) {
      if (feed.provider === 'github') {
        // 토큰이 있으면 비공개 저장소용 프로바이더(GitHub API)로 받는다
        const token = this.getToken()
        if (token) {
          feed.token = token
          feed.private = true
        }
      }
      autoUpdater.setFeedURL(feed)
      if (this.status.state === 'disabled') this.set({ state: 'idle', error: undefined })
    } else {
      this.set({ state: 'disabled', error: undefined })
    }

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (config.autoCheck && feed) {
      this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    }
  }

  /** 앱 시작 직후 한 번 확인 (설정이 켜져 있을 때) */
  checkOnStartup(): void {
    if (!this.config.autoCheck || this.status.state === 'disabled') return
    setTimeout(() => void this.check(), 4000)
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.state === 'disabled') return this.status
    if (this.status.state === 'checking' || this.status.state === 'downloading') return this.status
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // error 이벤트로도 오지만, 피드 설정 오류처럼 이벤트 없이 던지는 경우를 대비한다
      this.set({ state: 'error', error: friendlyError(err) })
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    if (this.status.state !== 'available') return this.status
    this.set({ state: 'downloading', percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.set({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return this.status
  }

  install(): void {
    if (this.status.state !== 'downloaded') return
    // isSilent=false: NSIS 설치 화면을 보여줌, isForceRunAfter=true: 설치 후 앱 재시작
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  logPath(): string {
    return log.transports.file.getFile().path
  }

  /** 실제로 쓰이는 피드 설명 (설정 화면 표시용) */
  feedDescription(): string {
    const feed = this.feedOptions(this.config)
    if (!feed) return ''
    if (feed.provider === 'github') {
      return `GitHub ${feed.owner}/${feed.repo}${this.getToken() ? ' (토큰 사용)' : ''}`
    }
    return feed.url
  }

  // ---------- 내부 ----------

  private feedOptions(c: UpdateConfig): FeedOptions | null {
    if (c.provider === 'github' && c.owner?.trim() && c.repo?.trim()) {
      return { provider: 'github', owner: c.owner.trim(), repo: c.repo.trim() }
    }
    if (c.provider === 'generic' && c.url?.trim()) {
      const url = c.url.trim()
      return url.includes(PLACEHOLDER_HOST) ? null : { provider: 'generic', url }
    }
    // 앱에서 따로 지정하지 않았으면 빌드에 포함된 기본 배포 위치를 쓴다
    return this.builtInFeed()
  }

  /** 패키징 시 electron-builder 가 넣어 둔 resources/app-update.yml (개발 모드에서는 dev-app-update.yml) */
  private builtInFeed(): FeedOptions | null {
    try {
      const file = app.isPackaged
        ? join(process.resourcesPath, 'app-update.yml')
        : join(app.getAppPath(), 'dev-app-update.yml')
      if (!existsSync(file)) return null
      const text = readFileSync(file, 'utf8')
      const get = (key: string): string | undefined => {
        const m = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(text)
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined
      }
      const provider = get('provider')
      if (provider === 'github') {
        const owner = get('owner')
        const repo = get('repo')
        return owner && repo ? { provider: 'github', owner, repo } : null
      }
      const url = get('url')
      if (!url || url.includes(PLACEHOLDER_HOST)) return null
      return { provider: 'generic', url }
    } catch {
      return null
    }
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch, currentVersion: app.getVersion() }
    if (!this.win.isDestroyed()) this.win.webContents.send('update:status', this.status)
  }
}
