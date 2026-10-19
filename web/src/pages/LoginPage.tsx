import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { demoEnabled, signIn } from '@/features/auth/auth'
import { homeFor } from '@/lib/permissions'
import { Button, Field, Input } from '@/components/ui'

const schema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
})
type Values = z.infer<typeof schema>

export default function LoginPage() {
  const { user, status } = useAuthStore()
  const nav = useNavigate()
  const loc = useLocation()
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) })

  if (status === 'authenticated' && user) return <Navigate to={homeFor(user.role)} replace />

  const from = (loc.state as { from?: string } | null)?.from

  const onSubmit = handleSubmit(async (v) => {
    setError(null)
    try {
      const u = await signIn(v.username, v.password)
      nav(from && from !== '/login' ? from : homeFor(u.role), { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed')
    }
  })

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-900 via-brand-800 to-slate-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center text-white">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20"><ShieldCheck className="h-6 w-6" /></div>
          <h1 className="text-2xl font-semibold">Handovers</h1>
          <p className="mt-1 text-sm text-brand-100">IT asset &amp; device handover system</p>
        </div>
        <form onSubmit={onSubmit} noValidate className="card space-y-4 p-6">
          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <Field label="Username" error={errors.username?.message}>
            <Input autoComplete="username" autoFocus invalid={!!errors.username} {...register('username')} />
          </Field>
          <Field label="Password" error={errors.password?.message}>
            <div className="relative">
              <Input type={show ? 'text' : 'password'} autoComplete="current-password" invalid={!!errors.password} className="pr-10" {...register('password')} />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>
          <Button type="submit" className="w-full" loading={isSubmitting}>Sign in</Button>
          {demoEnabled && (
            <p className="text-center text-xs text-slate-400">Dev fallback (backend offline): admin / manager / leader with password <code className="font-mono">demo</code></p>
          )}
        </form>
      </div>
    </div>
  )
}
