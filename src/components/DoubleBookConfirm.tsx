import { useCallback, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import {
  createAppointment,
  createAppointmentAllowingOverlap,
  isOverlapError,
} from '../lib/api'
import type { ApiError, ScheduleConflict } from '../lib/api'

/**
 * Scheduling-rule override for provider and admin screens.
 *
 * Visit-type durations are enforced as strict, exclusive time blocks by
 * default — that is what the family booking flow is held to and it can never
 * be overridden from the parent portal. Providers and admins run their own
 * schedules, so when one of them lands on an occupied block we don't refuse
 * it: we show what is already there and let them double-book on purpose.
 */

function to12h(t: string): string {
  const [h, m] = String(t).split(':').map(Number)
  if (Number.isNaN(h)) return String(t)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:${String(m || 0).padStart(2, '0')} ${ampm}`
}

interface Pending {
  conflicts: ScheduleConflict[]
  resolve: (overrideConfirmed: boolean) => void
}

/** Whatever shape the appointments API returns — same as createAppointment. */
type BookedAppointment = Awaited<ReturnType<typeof createAppointment>>

export interface BookOptions {
  /** Called instead of createAppointment — for flows with their own wrapper. */
  create?: (body: Record<string, unknown>) => Promise<BookedAppointment>
}

export function useDoubleBookConfirm() {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)

  const settle = useCallback((overrideConfirmed: boolean) => {
    pendingRef.current?.resolve(overrideConfirmed)
    pendingRef.current = null
    setPending(null)
  }, [])

  /** Opens the modal and resolves true when the user chooses to double-book. */
  const askDoubleBook = useCallback((conflicts: ScheduleConflict[]) => {
    return new Promise<boolean>(resolve => {
      const next = { conflicts, resolve }
      pendingRef.current = next
      setPending(next)
    })
  }, [])

  /**
   * Books an appointment, and if the time collides with something already on
   * the provider's schedule, asks whether to double-book and retries with the
   * override. Resolves to null when the user backs out, so callers can skip
   * their follow-up work (notifications, status updates) without an error.
   */
  const bookWithOverlapPrompt = useCallback(
    async (body: Record<string, unknown>, opts?: BookOptions): Promise<BookedAppointment | null> => {
      const create = opts?.create ?? createAppointment
      try {
        return await create(body)
      } catch (e) {
        if (!isOverlapError(e)) throw e
        const conflicts = (e as ApiError).conflicts ?? []
        const confirmed = await askDoubleBook(conflicts)
        if (!confirmed) return null
        return opts?.create
          ? await opts.create({ ...body, allow_overlap: true })
          : await createAppointmentAllowingOverlap(body)
      }
    },
    [askDoubleBook],
  )

  // Wrapped in its own stacking context so it always sits above the
  // add/edit appointment modal that triggered it, whatever the DOM order.
  const doubleBookModal = !pending ? null : (
    <div className="relative z-[60]">
      <Modal open onClose={() => settle(false)} title="Time already booked" size="md">
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="text-[#B45309] shrink-0 mt-0.5" />
            <p className="text-[13px] text-[#555] leading-relaxed">
              This time overlaps {pending.conflicts.length === 1 ? 'a visit' : 'visits'} already on
              this provider's schedule. You can book it anyway — the schedule will show both visits
              at the same time.
            </p>
          </div>

          {!!pending.conflicts.length && (
            <ul className="rounded-lg border border-[#E8E8E4] divide-y divide-[#E8E8E4] overflow-hidden">
              {pending.conflicts.map(c => (
                <li key={c.id} className="px-3 py-2 bg-[#FAFAF8]">
                  <div className="text-[13px] text-[#1A1A2E] font-medium">
                    {to12h(c.scheduled_time)} · {c.visit_type || 'Visit'}
                  </div>
                  <div className="text-[11px] text-[#777] mt-0.5">
                    {c.duration_minutes} min{c.provider_name ? ` · ${c.provider_name}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => settle(false)}>
              Pick another time
            </Button>
            <Button variant="danger" size="sm" onClick={() => settle(true)}>
              Double-book anyway
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )

  return { bookWithOverlapPrompt, askDoubleBook, doubleBookModal }
}
