import type { Metadata } from 'next'
import './globals.css'
import { GroundcoverRum } from './groundcover-rum'

export const metadata: Metadata = {
  title: 'Next.js App - Rum SDK Sample',
  description: 'Sample Next.js app with App Router for Rum SDK experiments',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <GroundcoverRum />
        {children}
      </body>
    </html>
  )
} 