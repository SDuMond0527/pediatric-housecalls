// Super-admin Practice Settings tab.
//
// Pick a practice from the dropdown → see every flag + identity +
// integration field → flip / edit → Save writes to DB and appends
// one audit row per changed field.
//
// Phase 1: UI is live, writes land in DB, audit log fills up — but
// NO existing PHC feature reads these flags yet. Flipping a toggle
// changes the data but doesn't change what the app shows. Flag-gating
// is Phase 2. Sara 2026-11-04.

import { useEffect, useState, useMemo } from 'react'
import { Sliders, Save, History, Loader2 } from 'lucide-react'
import {
  SETTINGS_GROUPS,
  parsePracticeSettings,
  type PracticeSettings,
} from '../../lib/practiceSettings'
import {
  getPractices,
  getAdminPracticeSettings,
  patchAdminPracticeSettings,
} from '../../lib/api'

type Practice = { id: string; name: string; slug: string }

type AuditRow = {
  field_path: string
  old_value: unknown
  new_value: unknown
  changed_by_name: string | null
  changed_at: string
}

export function AdminPracticeSettings() {
  const [practices, setPractices] = useState<Practice[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [settings, setSettings] = useState<PracticeSettings | null>(null)
  const [draft, setDraft] = useState<PracticeSettings | null>(null)
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Load practices on mount
  useEffect(() => {
    void getPractices()
      .then(ps => {
        setPractices(ps)
        if (ps.length > 0) setSelectedId(ps[0].id)
      })
      .catch(err => setLoadError(`Couldn't load practice list: ${err?.message ?? err}`))
  }, [])

  // Load settings when the selected practice changes
  useEffect(() => {
    if (!selectedId) return
    setLoading(true)
    setLoadError(null)
    getAdminPracticeSettings(selectedId)
      .then(data => {
        const parsed = parsePracticeSettings(data.settings)
        setSettings(parsed)
        setDraft(parsed)
        setAudit(data.audit)
      })
      .catch(err => {
        setSettings(null)
        setDraft(null)
        setAudit([])
        setLoadError(`Couldn't load settings for this practice: ${err?.message ?? err}`)
      })
      .finally(() => setLoading(false))
  }, [selectedId])

  const dirty = useMemo(() => {
    if (!settings || !draft) return false
    return JSON.stringify(settings) !== JSON.stringify(draft)
  }, [settings, draft])

  const changedFieldCount = useMemo(() => {
    if (!settings || !draft) return 0
    let n = 0
    for (const key of Object.keys(draft) as Array<keyof PracticeSettings>) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(draft[key])) n++
    }
    return n
  }, [settings, draft])

  async function handleSave() {
    if (!selectedId || !settings || !draft || !dirty) return
    setSaving(true)
    try {
      // Build a patch of only the changed fields
      const patch: Record<string, unknown> = {}
      for (const key of Object.keys(draft) as Array<keyof PracticeSettings>) {
        if (JSON.stringify(settings[key]) !== JSON.stringify(draft[key])) {
          patch[key as string] = draft[key]
        }
      }
      await patchAdminPracticeSettings(selectedId, patch)
      // Reload to pull fresh audit log
      const data = await getAdminPracticeSettings(selectedId)
      const parsed = parsePracticeSettings(data.settings)
      setSettings(parsed)
      setDraft(parsed)
      setAudit(data.audit)
    } catch (e: any) {
      alert(e.message ?? 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  function setField<K extends keyof PracticeSettings>(key: K, value: PracticeSettings[K]) {
    setDraft(d => (d ? { ...d, [key]: value } : d))
  }

  const selectedPractice = practices.find(p => p.id === selectedId)

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-5">
        <Sliders size={20} className="text-[#7F77DD]" />
        <h1 className="text-[20px] sm:text-[24px] font-semibold text-[#1A1A2E]">Practice Settings</h1>
      </div>

      <p className="text-[12px] text-[#666] mb-5 leading-snug">
        Per-practice feature toggles, identity values, and integration references.
        Changes save immediately and append to the audit log below.
        <strong className="text-[#1A1A2E]"> Phase 1 scaffolding:</strong> toggles write to the database but existing features don't read them yet. Flag-gating comes in Phase 2.
      </p>

      {/* Practice picker */}
      <div className="mb-4">
        <label className="text-[11px] uppercase tracking-wider text-[#555] font-medium block mb-1">Practice</label>
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          className="w-full sm:w-96 px-3 py-2 border border-[#E8E8E4] rounded-lg bg-white text-[14px] outline-none"
        >
          {practices.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[#666] text-[13px]">
          <Loader2 size={14} className="animate-spin" /> Loading settings…
        </div>
      )}

      {!loading && loadError && (
        <div className="rounded-md border border-[#FECACA] bg-[#FEE2E2] px-4 py-3 text-[12px] text-[#991B1B] leading-snug">
          <strong>Couldn't load settings.</strong>
          <div className="mt-1 font-mono text-[11px] text-[#7F1D1D] break-all whitespace-pre-wrap">{loadError}</div>
        </div>
      )}

      {!loading && draft && settings && (
        <>
          {/* Save bar */}
          <div className="sticky top-0 z-10 -mx-4 sm:-mx-6 mb-5 px-4 sm:px-6 py-3 bg-white border-y border-[#E8E8E4] flex items-center justify-between gap-2">
            <div className="text-[12px] text-[#666]">
              {dirty ? (
                <span><strong className="text-[#1A1A2E]">{changedFieldCount}</strong> {changedFieldCount === 1 ? 'change' : 'changes'} unsaved</span>
              ) : (
                <span>All changes saved.</span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowHistory(h => !h)}
                className="px-3 py-1.5 text-[12px] font-medium text-[#1A1A2E] border border-[#E8E8E4] rounded-md hover:bg-[#F8F8F4] flex items-center gap-1.5"
              >
                <History size={13} />
                {showHistory ? 'Hide history' : 'History'}
              </button>
              <button
                onClick={handleSave}
                disabled={!dirty || saving}
                className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#7F77DD] rounded-md hover:bg-[#6c65c7] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </button>
            </div>
          </div>

          {/* Groups */}
          {SETTINGS_GROUPS.map(group => (
            <section key={group.group} className="mb-6 bg-white border border-[#E8E8E4] rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 bg-[#F8F8F4] border-b border-[#E8E8E4]">
                <h2 className="text-[13px] font-semibold text-[#1A1A2E]">{group.group}</h2>
              </div>
              <div className="divide-y divide-[#F0F0EC]">
                {group.fields.map(f => {
                  const value = draft[f.key]
                  const isChanged = JSON.stringify(settings[f.key]) !== JSON.stringify(draft[f.key])
                  return (
                    <div
                      key={String(f.key)}
                      className={`px-4 py-2.5 flex items-center justify-between gap-3 ${isChanged ? 'bg-[#FFF9E5]' : ''}`}
                    >
                      <label className="flex-1 text-[13px] text-[#1A1A2E]">
                        {f.label}
                        <span className="ml-2 text-[10px] text-[#999] font-mono">{String(f.key)}</span>
                      </label>
                      <div className="shrink-0">
                        {f.kind === 'flag' && (
                          <input
                            type="checkbox"
                            checked={value === true}
                            onChange={e => setField(f.key, e.target.checked as any)}
                            className="w-4 h-4 cursor-pointer accent-[#7F77DD]"
                          />
                        )}
                        {f.kind === 'string' && (
                          <input
                            type="text"
                            value={value == null ? '' : String(value)}
                            onChange={e => setField(f.key, (e.target.value || null) as any)}
                            placeholder="(blank)"
                            className="w-44 sm:w-56 px-2 py-1 border border-[#E8E8E4] rounded text-[12px]"
                          />
                        )}
                        {f.kind === 'timezone' && (
                          <select
                            value={value == null ? 'America/New_York' : String(value)}
                            onChange={e => setField(f.key, e.target.value as any)}
                            className="w-44 sm:w-56 px-2 py-1 border border-[#E8E8E4] rounded text-[12px]"
                          >
                            <option value="America/New_York">America/New_York (Eastern)</option>
                            <option value="America/Chicago">America/Chicago (Central)</option>
                            <option value="America/Denver">America/Denver (Mountain)</option>
                            <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
                            <option value="America/Phoenix">America/Phoenix (Arizona)</option>
                            <option value="America/Anchorage">America/Anchorage (Alaska)</option>
                            <option value="Pacific/Honolulu">Pacific/Honolulu (Hawaii)</option>
                          </select>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}

          {/* Audit history */}
          {showHistory && (
            <section className="mb-6 bg-white border border-[#E8E8E4] rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 bg-[#F8F8F4] border-b border-[#E8E8E4]">
                <h2 className="text-[13px] font-semibold text-[#1A1A2E]">
                  Audit history — {selectedPractice?.name}
                </h2>
              </div>
              {audit.length === 0 ? (
                <p className="px-4 py-3 text-[12px] text-[#666]">No changes recorded yet.</p>
              ) : (
                <div className="divide-y divide-[#F0F0EC]">
                  {audit.map((a, idx) => (
                    <div key={idx} className="px-4 py-2.5 text-[12px] text-[#1A1A2E]">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="font-mono text-[11px] text-[#7F77DD]">{a.field_path}</span>
                        <span className="text-[10px] text-[#666]">
                          {new Date(a.changed_at).toLocaleString()} · by {a.changed_by_name ?? '(unknown)'}
                        </span>
                      </div>
                      {a.field_path === '_seed' ? (
                        <div className="text-[11px] text-[#666]">Initial seed of {Object.keys(a.new_value as object ?? {}).length} default values</div>
                      ) : (
                        <div className="text-[11px] text-[#666]">
                          <span className="line-through">{JSON.stringify(a.old_value) ?? '—'}</span>
                          {' → '}
                          <span className="text-[#1A7D5A]">{JSON.stringify(a.new_value) ?? '—'}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
