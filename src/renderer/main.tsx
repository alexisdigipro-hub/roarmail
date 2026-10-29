import './setup'
import './tips'
import { createRoot } from 'react-dom/client'
import '@fontsource/jost/300.css'
import '@fontsource/jost/700.css'
import './styles.css'
import './look.css'
import App from './App'

createRoot(document.getElementById('root')!).render(<App />)
