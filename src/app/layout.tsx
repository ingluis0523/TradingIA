import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'TradingIA — Bot de Cripto Automatizado',
  description: 'Dashboard profesional de trading automatizado con IA para BTC, ETH, SOL, BNB, XRP',
  icons: { icon: '/favicon.ico' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className={`${inter.className} antialiased min-h-screen bg-background`}>
        {children}
      </body>
    </html>
  )
}
