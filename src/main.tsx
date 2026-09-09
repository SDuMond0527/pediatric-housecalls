import './lib/amplify'
import * as Sentry from '@sentry/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Only initialize Sentry in production. Skipping localhost keeps dev-time
// noise (StrictMode double-mounts, HMR churn, etc.) out of Sara's inbox.
if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: 'production',
    // Send every error — this is a small practice, volume is low
    sampleRate: 1.0,
    // Don't send breadcrumbs for pageviews/console noise
    integrations: [],
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
