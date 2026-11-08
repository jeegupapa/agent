import type { PermissionRequest } from '../../../shared/types'
import { DiffView } from './DiffPanel'
import { toolIcon } from './ToolChip'

interface Props {
  request: PermissionRequest
  /** 팀 작업이면 "민준 · 로그인 화면 개선" 같은 출처 설명 */
  context?: string
  /** 대기 중인 다른 요청 수 */
  queued?: number
  onAllow: () => void
  onAlwaysAllow: () => void
  onDeny: () => void
}

export function PermissionDialog({ request, context, queued = 0, onAllow, onAlwaysAllow, onDeny }: Props) {
  const i = request.input
  const isEdit = request.toolName === 'Edit'
  const isWrite = request.toolName === 'Write'
  const isShell = request.toolName === 'Bash' || request.toolName === 'PowerShell'

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>
          {toolIcon(request.toolName)} 권한 요청: <b>{request.toolName}</b>
        </h3>
        <p className="muted">
          {context ? <><b>{context}</b> 이(가) 아래 작업을 실행하려고 합니다. 허용할까요?</> : 'Claude가 아래 작업을 실행하려고 합니다. 허용할까요?'}
          {queued > 0 && <span className="badge" style={{ marginLeft: 8 }}>대기 {queued}</span>}
        </p>

        {isShell && (
          <pre className="cmd">
            {String(i.description ?? '')}
            {i.description ? '\n\n' : ''}
            $ {String(i.command ?? '')}
          </pre>
        )}
        {isEdit && (
          <>
            <div className="mono small">{String(i.file_path ?? '')}</div>
            <DiffView before={String(i.old_string ?? '')} after={String(i.new_string ?? '')} />
          </>
        )}
        {isWrite && (
          <>
            <div className="mono small">{String(i.file_path ?? '')} (새 파일 또는 전체 덮어쓰기)</div>
            <DiffView before="" after={String(i.content ?? '')} />
          </>
        )}
        {!isShell && !isEdit && !isWrite && <pre>{JSON.stringify(i, null, 2)}</pre>}

        <div className="modal-actions">
          <button className="danger" onClick={onDeny}>
            거부
          </button>
          <button onClick={onAlwaysAllow} title="이 세션 동안 같은 종류의 도구는 다시 묻지 않음">
            항상 허용
          </button>
          <button className="primary" onClick={onAllow} autoFocus>
            허용
          </button>
        </div>
      </div>
    </div>
  )
}
