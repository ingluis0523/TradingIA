'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Activity, BarChart3, Settings, TrendingUp, Zap } from 'lucide-react'

const nav = [
  { href: '/', label: 'Dashboard', icon: Activity },
  { href: '/trades', label: 'Operaciones', icon: TrendingUp },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Configuración', icon: Settings },
]

interface NavbarProps {
  botRunning?: boolean
}

export function Navbar({ botRunning }: NavbarProps) {
  const pathname = usePathname()

  return (
    <nav className="sticky top-0 z-50 border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex h-14 items-center px-6 gap-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 font-bold text-base shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/20 border border-primary/30">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <span className="text-foreground">Trading<span className="text-primary">IA</span></span>
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-1 flex-1">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors',
                pathname === href
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2 shrink-0">
          <div className={cn('status-dot', botRunning ? '' : 'stopped')} />
          <span className="text-xs text-muted-foreground">
            {botRunning ? 'Bot activo' : 'Bot inactivo'}
          </span>
          <span className="text-xs text-muted-foreground ml-2 hidden sm:block">
            Testnet · Futuros USDT-M
          </span>
        </div>
      </div>
    </nav>
  )
}
