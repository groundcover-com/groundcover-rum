'use client'

import { useEffect } from 'react'

export default function Home() {
  useEffect(() => {
    // The SDK is initialized once, in groundcover-rum.tsx (rendered by layout.tsx).
    console.log('Next.js page mounted')
  }, [])

  return (
    <div className="container">
      <main className="main">
        <h1 className="title">
          Welcome to Next.js 15 with App Router
        </h1>
        
        <p className="description">
          This is a sample Next.js app using App Router 15 for Rum SDK experiments.
        </p>

        <div className="grid">
          <div className="card">
            <h2>Next.js 15 &rarr;</h2>
            <p>Latest version with App Router and React 19</p>
          </div>

          <div className="card">
            <h2>Rum SDK &rarr;</h2>
            <p>Real User Monitoring SDK integration</p>
          </div>

          <div className="card">
            <h2>Turborepo &rarr;</h2>
            <p>Monorepo setup with shared packages</p>
          </div>

          <div className="card">
            <h2>TypeScript &rarr;</h2>
            <p>Type-safe development experience</p>
          </div>
        </div>
      </main>
    </div>
  )
} 