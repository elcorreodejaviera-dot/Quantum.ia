import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { SignIn, SignUp, SignedIn, SignedOut, RedirectToSignIn } from '@clerk/clerk-react'
import BotPortal from './components/BotPortal'

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
      <Route path="/login" element={<SignIn routing="path" path="/login" />} />
      <Route path="/register" element={<SignUp routing="path" path="/register" />} />
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
