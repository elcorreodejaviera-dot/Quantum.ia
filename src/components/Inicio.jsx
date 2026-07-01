import React from 'react'
import { Link } from 'react-router-dom'
import '../styles/inicio.css'

// Portada pública (JAV-169). Visitantes no autenticados. Los CTAs llevan a las
// rutas reales de Clerk (/login, /register). Los puntos verdes son decorativos.
export default function Inicio() {
  return (
    <div className="inicio">
      <div className="inicio-glow" aria-hidden="true"></div>

      <header>
        <nav className="inicio-nav" aria-label="Principal">
          <span className="inicio-brand">
            <span className="inicio-dot inicio-dot-nav" aria-hidden="true"></span>
            Quantum<em>.ia</em>
          </span>
          <div className="inicio-actions">
            <Link to="/login" className="inicio-btn inicio-btn-ghost">Iniciar sesión</Link>
            <Link to="/register" className="inicio-btn inicio-btn-primary">Crear cuenta</Link>
          </div>
        </nav>
      </header>

      <main className="inicio-hero">
        <span className="inicio-badge">
          <span className="inicio-dot inicio-dot-badge" aria-hidden="true"></span>
          <span className="inicio-badge-text">Liquidity Hedge · en vivo</span>
        </span>
        <div className="inicio-title-row">
          <span className="inicio-dot inicio-dot-title" aria-hidden="true"></span>
          <h1 className="inicio-title">Quantum<em>.ia</em></h1>
        </div>
      </main>
    </div>
  )
}
