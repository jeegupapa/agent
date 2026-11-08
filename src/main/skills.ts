import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CreateSkillArgs, SkillInfo, SkillScope } from '../shared/types'

/** 스킬 폴더 위치: 사용자 전역은 ~/.claude/skills, 프로젝트는 <cwd>/.claude/skills */
export function skillsDir(scope: SkillScope, cwd: string): string {
  return scope === 'user' ? join(homedir(), '.claude', 'skills') : join(cwd, '.claude', 'skills')
}

/** SKILL.md 의 YAML 프런트매터에서 name / description 만 뽑는다 */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line)
    if (kv) {
      const key = kv[1] as 'name' | 'description'
      out[key] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out
}

export function listSkills(cwd: string): SkillInfo[] {
  const result: SkillInfo[] = []
  for (const scope of ['user', 'project'] as SkillScope[]) {
    const dir = skillsDir(scope, cwd)
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const name of entries) {
      const file = join(dir, name, 'SKILL.md')
      if (!existsSync(file)) continue
      let fm: { name?: string; description?: string } = {}
      try {
        fm = parseFrontmatter(readFileSync(file, 'utf8'))
      } catch {
        /* 무시 */
      }
      result.push({
        name: fm.name || name,
        description: fm.description || '',
        scope,
        path: join(dir, name)
      })
    }
  }
  return result
}

export function createSkill(args: CreateSkillArgs): SkillInfo {
  const safeName = args.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!safeName) throw new Error('스킬 이름은 영문 소문자, 숫자, 하이픈만 쓸 수 있습니다.')
  const dir = join(skillsDir(args.scope, args.cwd), safeName)
  if (existsSync(join(dir, 'SKILL.md'))) throw new Error(`이미 같은 이름의 스킬이 있습니다: ${safeName}`)
  mkdirSync(dir, { recursive: true })
  const description = args.description.trim().replace(/\r?\n/g, ' ')
  const body = args.body.trim() || `# ${safeName}\n\n여기에 Claude가 따를 지침을 적으세요.\n`
  const md = `---\nname: ${safeName}\ndescription: ${description}\n---\n\n${body}\n`
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf8')
  return { name: safeName, description, scope: args.scope, path: dir }
}
