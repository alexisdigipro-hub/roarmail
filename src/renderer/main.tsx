import './setup'
import './tips'
import { createRoot } from 'react-dom/client'
import '@fontsource/jost/300.css'
import '@fontsource/jost/700.css'
import './styles.css'
import './look.css'
import App from './App'

// a file dropped anywhere outside a drop area is not opened as a page in the window (security review 29 Oct 2026)
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// the backdrop's slow drift stops while the window is in the background or hidden (look.css html[data-away])
const away = () => { if (document.hidden || !document.hasFocus()) document.documentElement.dataset.away = ''; else delete document.documentElement.dataset.away }
addEventListener('blur', away); addEventListener('focus', away); document.addEventListener('visibilitychange', away)

createRoot(document.getElementById('root')!).render(<App />)
