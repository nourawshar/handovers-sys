import { useMemo } from 'react'
import { useDepartments, useRooms } from '@/api/hooks'
import { Field, Input, Select } from '@/components/ui'

/** Manual work-identity input (CHANGE 4). Draft field shape used by both wizards. */
export interface WorkIdentityValue {
  name: string
  departmentTeamId: string
  roomId: string
}

export const emptyWorkIdentity = (): WorkIdentityValue => ({ name: '', departmentTeamId: '', roomId: '' })

/**
 * Manual name + department picker + CONDITIONAL room `<Select>`.
 * The work-name input and the room field are shown only when the chosen department is a
 * call-center (`type === 'CALLCENTER'`); non-call-center identities use the employee's real
 * name (no work identity) and never show a room, clearing any previously chosen one.
 */
export function WorkIdentityFields({ value, onChange, errors, className }: {
  value: WorkIdentityValue
  onChange: (patch: Partial<WorkIdentityValue>) => void
  errors: Record<string, string | undefined>
  className?: string
}) {
  const departments = useDepartments()
  const rooms = useRooms()
  const selectedDept = departments.data?.find((d) => d.id === value.departmentTeamId)
  const isCallCenter = selectedDept?.type === 'CALLCENTER'

  // Only call-center rooms (TR1–TR4) are assignable seats.
  const callCenterRooms = useMemo(
    () => (rooms.data ?? []).filter((r) => r.teamType === 'CALLCENTER'),
    [rooms.data],
  )

  const setDepartment = (departmentTeamId: string) => {
    const dept = departments.data?.find((d) => d.id === departmentTeamId)
    const patch: Partial<WorkIdentityValue> = { departmentTeamId }
    // Non-call-center → no work name / room; clear any previous values so they aren't sent.
    if (dept?.type !== 'CALLCENTER') {
      patch.name = ''
      patch.roomId = ''
    }
    onChange(patch)
  }

  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${className ?? ''}`}>
      {isCallCenter ? (
        <Field label="Work identity name" hint="e.g. sofia — the seat label" required error={errors.name}>
          <Input value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="sofia" aria-label="Work identity name" />
        </Field>
      ) : (
        <p className="text-sm text-slate-500">No work identity — the employee's real name is used.</p>
      )}
      <Field label="Department" required error={errors.departmentTeamId}>
        <Select value={value.departmentTeamId} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">— select department —</option>
          {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      {isCallCenter && (
        <Field label="Room" hint="Call-center seats require a room" required error={errors.roomId}>
          <Select value={value.roomId} onChange={(e) => onChange({ roomId: e.target.value })} aria-label="Room">
            <option value="">— select room —</option>
            {callCenterRooms.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
          </Select>
        </Field>
      )}
    </div>
  )
}
