'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useTheme } from '@/components/ThemeProvider'
import {
  Activity, BarChart3, Settings, TrendingUp, Zap,
  Moon, Sun, Menu, X, Cpu,
} from 'lucide-react'

const nav = [
  { href: '/',          label: 'Dashboard',     icon: Activity    },
  { href: '/trades',    label: 'Operaciones',   icon: TrendingUp  },
  { href: '/analytics', label: 'Analytics',     icon: BarChart3   },
  { href: '/settings',  label: 'Configuración', icon: Settings    },
]

interface ModeFlags {
  tradingMode: 'testnet' | 'mainnet'
  shadowMode: boolean
}

interface NavbarProps {
  botRunning?: boolean
}

export function Navbar({ botRunning }: NavbarProps) {
  const pathname = usePathname()
  const { theme, toggle } = useTheme()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mode, setMode] = useState<ModeFlags | null>(null)

  useEffect(() => {
    fetch('/api/system/mode')
      .then((r) => r.json())
      .then((data: ModeFlags) => setMode(data))
      .catch(() => {})
  }, [])

  return (
    <nav className="sticky top-0 z-50 border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* Mode banner */}
      {mode?.shadowMode && (
        <div className="flex items-center justify-center bg-yellow-500/20 border-b border-yellow-500/50 text-yellow-300 px-3 py-1.5 text-xs font-medium">
          🔬 SHADOW MODE — operaciones simuladas, no se ejecutan órdenes reales
        </div>
      )}
      {mode?.tradingMode === 'testnet' && !mode?.shadowMode && (
        <div className="flex items-center justify-center bg-blue-500/20 border-b border-blue-500/50 text-blue-300 px-3 py-1.5 text-xs font-medium">
          🧪 TESTNET — operando con fondos de prueba
        </div>
      )}
      {mode?.tradingMode === 'mainnet' && !mode?.shadowMode && (
        <div className="flex items-center justify-center bg-red-500/20 border-b border-red-500/50 text-red-300 px-3 py-1.5 text-xs font-medium">
          🔴 MAINNET — operaciones con dinero real
        </div>
      )}

      {/* Main bar */}
      <div className="flex h-14 items-center px-4 md:px-6 gap-3">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 font-bold text-base shrink-0" onClick={() => setMobileOpen(false)}>
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/20 border border-primary/30">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <span>Trading<span className="text-primary">IA</span></span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-1 flex-1">
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

        {/* Right side */}
        <div className="flex items-center gap-2 ml-auto">
          {/* Bot status — hidden on smallest screens */}
          <div className={cn(
            'hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium',
            botRunning
              ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400'
              : 'bg-muted border-border text-muted-foreground'
          )}>
            <Cpu className="w-3 h-3" />
            <div className={cn('w-1.5 h-1.5 rounded-full', botRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground')} />
            <span className="hidden lg:inline">{botRunning ? 'Bot activo' : 'Bot inactivo'}</span>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggle}
            className="flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-secondary/60 transition-colors"
            aria-label="Cambiar tema"
          >
            {theme === 'dark'
              ? <Sun className="w-4 h-4 text-yellow-400" />
              : <Moon className="w-4 h-4 text-blue-500" />
            }
          </button>

          {/* Hamburger — mobile only */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-secondary/60 transition-colors"
            aria-label="Menú"
          >
            {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden border-t border-border/60 bg-background/98 animate-fade-in">
          <div className="px-4 py-3 space-y-1">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                  pathname === href
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            ))}

            {/* Bot status on mobile */}
            <div className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium mt-2',
              botRunning
                ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400'
                : 'bg-muted border-border text-muted-foreground'
            )}>
              <div className={cn('w-2 h-2 rounded-full', botRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground')} />
              {mode?.tradingMode?.toUpperCase() ?? 'TESTNET'} · Futuros USDT-M · {botRunning ? 'Bot activo' : 'Bot inactivo'}
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}
