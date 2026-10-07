import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './settings' // applies the saved theme and table font before the first render
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
