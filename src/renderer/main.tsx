import { createRoot } from 'react-dom/client'
import '@fontsource/jost/300.css'
import '@fontsource/jost/700.css'
import './styles.css'
import App from './App'

document.documentElement.dataset.platform = window.roarmail?.platform || 'web'
createRoot(document.getElementById('root')!).render(<App />)
