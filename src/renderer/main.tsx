import './setup'
import './tips'
import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/jost/300.css'
import '@fontsource/jost/700.css'
import './styles.css'
import './look.css'
import App from './App'
import { ComposeWindow } from './ComposeWindow'

// a file dropped anywhere outside a drop area is not opened as a page in the window (security review 29 Oct 2026)
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// a screen that breaks never leaves the window blank (1 Nov 2026): it says so, with a button that loads it again
class Guard extends Component<{ children: ReactNode }, { broke: string }> {
  state = { broke: '' }
  static getDerivedStateFromError(e: unknown) { return { broke: String((e as Error)?.message || e).slice(0, 200) } }
  componentDidCatch(e: unknown) { console.error('RoarMail screen error', e) }
  render() {
    if (!this.state.broke) return this.props.children
    const again = () => { const r = (window as any).roarmail; if (r?.rescue) r.rescue('retry'); else location.reload() }
    return (
      <div className="boot" style={{ textAlign: 'center' }}>
        <div>
          <div className="empty-mark"><b>ROAR</b><i>MAIL</i></div>
          <p style={{ margin: '14px 0 18px', opacity: 0.8 }}>Something went wrong on this screen. Your mail is safe.</p>
          <button className="pill" onClick={again}>Load again</button>
          <p style={{ marginTop: 16, fontSize: 11, opacity: 0.45 }}>{this.state.broke}</p>
        </div>
      </div>
    )
  }
}

// a message being written in its own window (index.html#compose=<id>), else the whole app
const composeId = (location.hash.match(/^#compose=([0-9a-f]+)$/) || [])[1]
createRoot(document.getElementById('root')!).render(<Guard>{composeId ? <ComposeWindow id={composeId} /> : <App />}</Guard>)
