import { Link } from 'react-router-dom'
import { Construction, ShieldOff, Compass } from 'lucide-react'
import { Button, PageHeader } from '@/components/ui'

export function ComingSoon({ title, phase, note }: { title: string; phase: string; note?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
        <Construction className="h-10 w-10 text-slate-300" />
        <p className="text-sm font-medium text-slate-700">Scheduled for {phase}</p>
        <p className="max-w-md text-xs text-slate-500">{note ?? 'The route and access rules are in place; the screen ships with its backend module.'}</p>
      </div>
    </>
  )
}

export function Forbidden() {
  return (
    <div className="card mx-auto mt-10 flex max-w-md flex-col items-center gap-3 px-6 py-14 text-center">
      <ShieldOff className="h-10 w-10 text-red-400" />
      <h1 className="text-lg font-semibold text-slate-900">Access denied</h1>
      <p className="text-sm text-slate-500">Your role doesn’t have permission to view this page.</p>
      <Link to="/dashboard"><Button variant="secondary">Back to dashboard</Button></Link>
    </div>
  )
}

export function NotFound() {
  return (
    <div className="card mx-auto mt-10 flex max-w-md flex-col items-center gap-3 px-6 py-14 text-center">
      <Compass className="h-10 w-10 text-slate-300" />
      <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
      <Link to="/dashboard"><Button variant="secondary">Back to dashboard</Button></Link>
    </div>
  )
}
