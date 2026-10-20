import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAssets, useEmployee } from '@/api/hooks'
import { fmtDate } from '@/lib/utils'
import { EmptyState, ErrorState, Badge, PageHeader, Spinner, StatusBadge, TableWrap } from '@/components/ui'

/** Chips for the devices an employee currently holds (GET /assets?holderId=…). */
function HeldDevices({ employeeId }: { employeeId: string }) {
  const { data, isLoading, isError } = useAssets({ holderId: employeeId, pageSize: 50 })
  if (isLoading) return <span className="text-xs text-slate-400">Loading…</span>
  if (isError) return <span className="text-xs text-red-600">Could not load devices</span>
  if (!data?.items.length) return <span className="text-xs text-slate-400">No devices held</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {data.items.map((d) => (
        <Link key={d.id} to={`/assets/${d.id}`} className="rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs text-brand-800 hover:bg-brand-100" title={d.name}>{d.code}</Link>
      ))}
    </div>
  )
}

export default function EmployeeDetailPage() {
  const { id = '' } = useParams()
  const { data, isLoading, isError, refetch } = useEmployee(id)

  return (
    <>
      <div className="mb-2">
        <Link to="/employees" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-brand-700"><ArrowLeft className="h-3.5 w-3.5" />Back to employees</Link>
      </div>
      {isLoading ? <Spinner /> : isError ? (
        <ErrorState error={{ message: 'Could not load this employee.' }} onRetry={() => refetch()} />
      ) : !data ? (
        <EmptyState title="Employee not found" action={<Link to="/employees" className="text-brand-700 text-sm">Back to employees</Link>} />
      ) : (
        <>
          <PageHeader title={data.employee.fullName} subtitle="Employee profile and device history" />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card gap-3">
              <div className="flex items-center justify-between">
                <span className="label">Status</span>
                <StatusBadge value={data.employee.status} />
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="label">Team</span><div>{data.employee.departmentTeam?.name ?? '—'}</div></div>
                <div><span className="label">Room</span><div>{data.employee.room?.code ?? '—'}</div></div>
                <div><span className="label">Phone contact</span><div>{data.employee.phoneContact ?? '—'}</div></div>
                <div><span className="label">Internal email</span><div>{data.employee.internalEmail ?? '—'}</div></div>
              </div>
              {data.employee.notes && <div><span className="label">Notes</span><p className="text-sm text-slate-700">{data.employee.notes}</p></div>}
            </div>
            <div className="card lg:col-span-2">
              <h3 className="label mb-2">Devices currently held ({data.employee.fullName})</h3>
              <HeldDevices employeeId={data.employee.id} />
            </div>
          </div>

          <div className="card mt-4 overflow-hidden">
            <div className="border-b border-slate-200 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-800">Assignment history</h3>
            </div>
            {!data.history.length ? (
              <EmptyState title="No assignment history" hint="This employee has not been part of any asset assignment yet." />
            ) : (
              <TableWrap>
                <thead className="bg-slate-50"><tr>
                  <th className="th">Assignment</th><th className="th">Device</th><th className="th">Work identity</th><th className="th">Status</th><th className="th">Assigned</th><th className="th">Returned</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.history.map((h) => (
                    <tr key={h.assignmentId} className="hover:bg-slate-50">
                      <td className="td">
                        <Link to={`/assignments/${h.assignmentId}`} className="font-mono text-xs text-brand-700 hover:underline">{h.assignmentCode}</Link>
                      </td>
                      <td className="td">
                        <Badge tone="blue">{h.assetCode}</Badge>
                        {h.assetName && <div className="mt-0.5 text-xs text-slate-400">{h.assetName}</div>}
                      </td>
                      <td className="td">{h.workIdentityName ?? '—'}</td>
                      <td className="td"><StatusBadge value={h.status} /></td>
                      <td className="td">{fmtDate(h.assignedAt, true)}</td>
                      <td className="td">{fmtDate(h.returnedAt, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </div>
        </>
      )}
    </>
  )
}