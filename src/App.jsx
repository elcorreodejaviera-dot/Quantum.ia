import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { SignIn, SignUp, SignedIn, SignedOut } from '@clerk/clerk-react'
import BotPortal from './components/BotPortal'
import AdminView from './components/AdminView'
import SpotGridView from './components/SpotGridView'
import AuthLayout from './components/AuthLayout'

function ProtectedRoute({ children }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut><Navigate to="/login" replace /></SignedOut>
    </>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
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
