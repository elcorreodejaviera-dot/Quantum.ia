import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { SignIn, SignUp, SignedIn, SignedOut, useAuth } from '@clerk/clerk-react'
import BotPortal from './components/BotPortal'
import AdminView from './components/AdminView'
import SpotGridView from './components/SpotGridView'
import AuthLayout from './components/AuthLayout'
import Inicio from './components/Inicio'

function ProtectedRoute({ children }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut><Navigate to="/login" replace /></SignedOut>
    </>
  )
}

// Portada en "/": espera a que Clerk cargue (isLoaded) antes de decidir para
// evitar flash de landing / redirección prematura (relevante por el race de
// primer login, JAV-82). Autenticado → dashboard; visitante → landing.
function HomeRoute() {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded) {
    return (
      <div className="inicio" role="status" aria-live="polite">
        <span className="inicio-loading">Cargando…</span>
      </div>
    )
  }
  if (isSignedIn) return <Navigate to="/dashboard" replace />
  return <Inicio />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/login/*" element={
        <AuthLayout>
          <SignIn routing="path" path="/login" fallbackRedirectUrl="/dashboard" />
        </AuthLayout>
      } />
      <Route path="/register/*" element={
        <AuthLayout>
          <SignUp routing="path" path="/register" fallbackRedirectUrl="/dashboard" />
        </AuthLayout>
      } />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <BotPortal />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminView />
          </ProtectedRoute>
        }
      />
      <Route
        path="/spot-grid"
        element={
          <ProtectedRoute>
            <SpotGridView />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}
