import React from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'

export default function AuthLayout({ children }) {
  const { isSignedIn, isLoaded } = useAuth()

  if (!isLoaded) {
    return (
      <div className="login-page">
        <div style={{ width: 'min(100%, 420px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', padding: '0 2px' }}>
            <span className="brand">Quantum<em>.ia</em></span>
            <span className="pill">Clerk</span>
          </div>
          <div className="panel">
            <div className="section-head">
              <h2>Cargando acceso</h2>
              <span className="pill">Auth</span>
            </div>
            <p className="network">Inicializando Clerk.</p>
          </div>
        </div>
      </div>
    )
  }

  if (isSignedIn) return <Navigate to="/dashboard" replace />

  return (
    <div className="login-page">
      <div style={{ width: 'min(100%, 420px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', padding: '0 2px' }}>
          <span className="brand">Quantum<em>.ia</em></span>
          <span className="pill">Acceso privado</span>
        </div>
        {children}
        {/* Contenedor donde Clerk monta el CAPTCHA/bot-challenge (Smart CAPTCHA / Turnstile). Sin este
            elemento, si a un usuario se le dispara el challenge durante el sign-in (verificación/reset),
            el flujo puede quedarse colgado antes de llegar a la contraseña. */}
        <div id="clerk-captcha" />
      </div>
    </div>
  )
}
