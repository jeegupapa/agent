import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

/** <pre> 를 감싸 언어 표시와 복사 버튼을 붙인다 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  // react-markdown 은 <pre><code class="hljs language-xxx">…</code></pre> 형태로 준다
  const codeEl = Array.isArray(children) ? children[0] : children
  const props = (codeEl as { props?: { className?: string; children?: ReactNode } })?.props
  const lang = /language-([\w+-]+)/.exec(props?.className ?? '')?.[1] ?? ''

  const copy = (): void => {
    const text = extractText(props?.children)
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'text'}</span>
        <button onClick={copy}>{copied ? '복사됨' : '복사'}</button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  const props = (node as { props?: { children?: ReactNode } }).props
  return props ? extractText(props.children) : ''
}

/** 어시스턴트 답변용 마크다운 렌더러 (GFM 표·체크박스, 코드 하이라이트) */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }}
    >
      {text}
    </ReactMarkdown>
  )
})
