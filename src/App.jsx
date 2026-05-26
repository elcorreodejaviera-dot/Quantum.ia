import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { SignIn, SignUp, SignedIn, SignedOut, RedirectToSignIn } from '@clerk/clerk-react'
import BotPortal from './components/BotPortal'
import AuthLayout from './components/AuthLayout'

function ProtectedRoute({ children }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut><RedirectToSignIn redirectUrl="/dashboard" /></SignedOut>
    </>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={
        <AuthLayout>
          <SignIn routing="path" path="/login" afterSignInUrl="/dashboard" />
        </AuthLayout>
      } />
      <Route path="/register" element={
        <AuthLayout>
          <SignUp routing="path" path="/register" afterSignUpUrl="/dashboard" />
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
    </Routes>
  )
}
