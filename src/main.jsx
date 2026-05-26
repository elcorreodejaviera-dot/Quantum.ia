import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider, useAuth } from '@clerk/clerk-react'
import { ConvexReactClient } from 'convex/react'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import App from './App'
import './styles/bot-portal.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
const CONVEX_URL = import.meta.env.VITE_CONVEX_URL

if (!PUBLISHABLE_KEY) {
  throw new Error('Falta VITE_CLERK_PUBLISHABLE_KEY en .env.local')
}
if (!CONVEX_URL) {
  throw new Error('Falta VITE_CONVEX_URL en .env.local')
}

const convex = new ConvexReactClient(CONVEX_URL)

const clerkAppearance = {
  variables: {
    colorBackground: '#101010',
    colorInputBackground: '#1a1a1a',
    colorText: '#ffffff',
    colorTextSecondary: '#b7bdb9',
    colorPrimary: '#00c805',
    colorInputText: '#ffffff',
    colorTextOnPrimaryBackground: '#000000',
    borderRadius: '8px',
  },
  elements: {
    card: {
      background: '#101010',
      border: '1px solid rgba(255,255,255,0.1)',
      boxShadow: '0 24px 60px rgba(0,0,0,0.34)',
    },
    socialButtonsBlockButton: {
      background: '#1a1a1a',
      border: '1px solid rgba(255,255,255,0.1)',
      color: '#ffffff',
    },
    dividerLine: { background: 'rgba(255,255,255,0.1)' },
    dividerText: { color: '#747a76' },
    footerActionLink: { color: '#00c805' },
    identityPreviewText: { color: '#ffffff' },
    identityPreviewEditButton: { color: '#00c805' },
  },
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} appearance={clerkAppearance}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <App />
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </BrowserRouter>
  </React.StrictMode>
)
