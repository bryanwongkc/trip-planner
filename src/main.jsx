import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

function installPwaViewportGuards() {
  const preventDefault = (event) => event.preventDefault()

  document.addEventListener('gesturestart', preventDefault, { passive: false })
  document.addEventListener('gesturechange', preventDefault, { passive: false })
  document.addEventListener('gestureend', preventDefault, { passive: false })
  document.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches?.length > 1) event.preventDefault()
    },
    { passive: false },
  )
  document.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault()
    },
    { passive: false },
  )
  document.addEventListener('dragstart', preventDefault)
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
