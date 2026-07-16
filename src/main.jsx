import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

function installPwaViewportGuards() {
  const preventDefault = (event) => event.preventDefault()
  const isTextEditingTarget = (target) =>
    target instanceof Element && Boolean(target.closest("input, textarea, [contenteditable='true']"))

  document.addEventListener('dragstart', preventDefault)
  document.addEventListener(
    'selectstart',
    (event) => {
      if (!isTextEditingTarget(event.target)) event.preventDefault()
    },
    { passive: false },
  )
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed', error)
    })
  })
}

installPwaViewportGuards()

createRoot(document.getElementById('root')).render(<App />)
