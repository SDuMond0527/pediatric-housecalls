import { useEffect, useState } from 'react'
import { BookOpen, Plus, Pencil, Trash2, Check, X, AlertCircle } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/Button'
import {
  getHandbook,
  createHandbookSection, updateHandbookSection, deleteHandbookSection,
  createHandbookEntry,   updateHandbookEntry,   deleteHandbookEntry,
  type HandbookSection, type HandbookEntry,
} from '../lib/api'

// "All things PHC" — provider-facing in-app handbook (Sara 2026-09-21).
// Two-column layout: section list on the left, entries on the right.
// Admins get inline add/edit/delete controls; non-admins get read-only.
// Content storage is DB-backed so Sara can update frequently without
// pinging me for a commit.

export function Handbook() {
  const { provider } = useAuth()
  const isAdmin = !!provider?.is_admin

  const [sections, setSections] = useState<HandbookSection[]>([])
  const [entries,  setEntries]  = useState<HandbookEntry[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)

  // Editing state — one at a time. Keeps the UI simple; if you're mid-edit
  // and click Edit on something else, we don't gracefully save the first
  // one, so keep the flow "edit → save/cancel → edit next".
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null)
  const [editingSectionTitle, setEditingSectionTitle] = useState('')
  const [addingEntry, setAddingEntry] = useState(false)
  const [newEntryTitle, setNewEntryTitle] = useState('')
  const [newEntryBody, setNewEntryBody] = useState('')
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [editingEntryTitle, setEditingEntryTitle] = useState('')
  const [editingEntryBody, setEditingEntryBody] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try {
      const data = await getHandbook()
      setSections(data.sections)
      setEntries(data.entries)
      // Preserve current selection if still present, else pick first.
      setActiveSectionId(prev =>
        prev && data.sections.some(s => s.id === prev)
          ? prev
          : (data.sections[0]?.id ?? null)
      )
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load handbook')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const activeSection = sections.find(s => s.id === activeSectionId)
  const activeEntries = entries.filter(e => e.section_id === activeSectionId)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))

  async function handleAddSection() {
    const title = window.prompt('New section title (e.g. "Colleague contact info")')
    if (!title || !title.trim()) return
    setBusy(true); setError(null)
    try {
      const created = await createHandbookSection(title.trim(), sections.length)
      setSections(prev => [...prev, created].sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title)))
      setActiveSectionId(created.id)
    } catch (e: any) { setError(e?.message ?? 'Failed to create section') }
    finally { setBusy(false) }
  }

  async function handleRenameSection() {
    if (!editingSectionId || !editingSectionTitle.trim()) return
    setBusy(true); setError(null)
    try {
      const updated = await updateHandbookSection(editingSectionId, { title: editingSectionTitle.trim() })
      setSections(prev => prev.map(s => s.id === updated.id ? updated : s))
      setEditingSectionId(null); setEditingSectionTitle('')
    } catch (e: any) { setError(e?.message ?? 'Failed to rename section') }
    finally { setBusy(false) }
  }

  async function handleDeleteSection(id: string) {
    const s = sections.find(x => x.id === id)
    const entryCount = entries.filter(e => e.section_id === id).length
    if (!window.confirm(`Delete section "${s?.title}"${entryCount > 0 ? ` and all ${entryCount} entries in it` : ''}? This can't be undone.`)) return
    setBusy(true); setError(null)
    try {
      await deleteHandbookSection(id)
      const remaining = sections.filter(s => s.id !== id)
      setSections(remaining)
      setEntries(prev => prev.filter(e => e.section_id !== id))
      if (activeSectionId === id) setActiveSectionId(remaining[0]?.id ?? null)
    } catch (e: any) { setError(e?.message ?? 'Failed to delete section') }
    finally { setBusy(false) }
  }

  async function handleAddEntry() {
    if (!activeSectionId || !newEntryTitle.trim()) return
    setBusy(true); setError(null)
    try {
      const created = await createHandbookEntry(activeSectionId, newEntryTitle.trim(), newEntryBody, activeEntries.length)
      setEntries(prev => [...prev, created])
      setAddingEntry(false); setNewEntryTitle(''); setNewEntryBody('')
    } catch (e: any) { setError(e?.message ?? 'Failed to add entry') }
    finally { setBusy(false) }
  }

  async function handleSaveEntry() {
    if (!editingEntryId || !editingEntryTitle.trim()) return
    setBusy(true); setError(null)
    try {
      const updated = await updateHandbookEntry(editingEntryId, { title: editingEntryTitle.trim(), body: editingEntryBody })
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      setEditingEntryId(null); setEditingEntryTitle(''); setEditingEntryBody('')
    } catch (e: any) { setError(e?.message ?? 'Failed to save entry') }
    finally { setBusy(false) }
  }

  async function handleDeleteEntry(id: string) {
    const e = entries.find(x => x.id === id)
    if (!window.confirm(`Delete "${e?.title}"? This can't be undone.`)) return
    setBusy(true); setError(null)
    try {
      await deleteHandbookEntry(id)
      setEntries(prev => prev.filter(x => x.id !== id))
    } catch (e: any) { setError(e?.message ?? 'Failed to delete entry') }
    finally { setBusy(false) }
  }

  const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]'

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <BookOpen size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">All things PHC</div>
            <div className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
              {isAdmin ? 'Handbook — you can add and edit content here.' : 'Handbook — reference for the practice.'}
            </div>
          </div>
        </div>
        {isAdmin && (
          <Button size="sm" variant="secondary" onClick={handleAddSection} loading={busy && sections.length === 0}>
            <Plus size={13} /> Add section
          </Button>
        )}
      </div>

      {error && (
        <div className="mx-6 mt-3 flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-[13px] text-[#1A1A2E]/60">Loading…</div>
      ) : sections.length === 0 ? (
        <div className="p-16 text-center">
          <BookOpen size={32} className="text-[#1A1A2E]/20 mx-auto mb-3" />
          <div className="text-[14px] text-[#1A1A2E]/70">No handbook content yet.</div>
          {isAdmin && (
            <Button className="mt-4" variant="teal" size="sm" onClick={handleAddSection}>
              <Plus size={13} /> Add your first section
            </Button>
          )}
        </div>
      ) : (
        <div className="flex gap-6 p-6 max-w-6xl">
          {/* Section list */}
          <aside className="w-56 flex-shrink-0">
            <div className="space-y-1">
              {sections.map(s => {
                const isActive = s.id === activeSectionId
                const isEditing = s.id === editingSectionId
                if (isEditing) {
                  return (
                    <div key={s.id} className="p-2 border-2 border-[#7F77DD] rounded-lg bg-white space-y-2">
                      <input
                        value={editingSectionTitle}
                        onChange={e => setEditingSectionTitle(e.target.value)}
                        className={inputCls}
                        autoFocus
                        onKeyDown={e => e.key === 'Enter' && handleRenameSection()}
                      />
                      <div className="flex gap-1.5">
                        <Button size="xs" variant="teal" loading={busy} onClick={handleRenameSection}><Check size={11} /> Save</Button>
                        <Button size="xs" variant="secondary" onClick={() => { setEditingSectionId(null); setEditingSectionTitle('') }}><X size={11} /> Cancel</Button>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={s.id} className={`group flex items-center gap-1 rounded-lg ${isActive ? 'bg-[#EEEDFE]' : 'hover:bg-[#FAFAF8]'}`}>
                    <button
                      onClick={() => setActiveSectionId(s.id)}
                      className={`flex-1 text-left px-3 py-2 text-[13px] font-medium ${isActive ? 'text-[#7F77DD]' : 'text-[#1A1A2E]'}`}
                    >
                      {s.title}
                    </button>
                    {isAdmin && (
                      <div className="flex gap-0.5 pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => { setEditingSectionId(s.id); setEditingSectionTitle(s.title) }}
                          className="p-1 text-[#1A1A2E]/60 hover:text-[#7F77DD]"
                          title="Rename section"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={() => handleDeleteSection(s.id)}
                          className="p-1 text-[#1A1A2E]/60 hover:text-[#991B1B]"
                          title="Delete section"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </aside>

          {/* Entries for the active section */}
          <main className="flex-1 min-w-0 space-y-3">
            {activeSection && (
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-display text-[18px] font-medium text-[#1A1A2E]">{activeSection.title}</h2>
                {isAdmin && !addingEntry && (
                  <Button size="xs" variant="secondary" onClick={() => { setAddingEntry(true); setNewEntryTitle(''); setNewEntryBody('') }}>
                    <Plus size={11} /> Add entry
                  </Button>
                )}
              </div>
            )}

            {isAdmin && addingEntry && (
              <div className="p-4 border-2 border-[#7F77DD] rounded-lg bg-white space-y-2">
                <input
                  value={newEntryTitle}
                  onChange={e => setNewEntryTitle(e.target.value)}
                  placeholder="Title (e.g. a question, or a person's name)"
                  className={inputCls}
                  autoFocus
                />
                <textarea
                  value={newEntryBody}
                  onChange={e => setNewEntryBody(e.target.value)}
                  placeholder="Content (answer, contact details, whatever fits)"
                  rows={4}
                  className={`${inputCls} resize-y`}
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="teal" loading={busy} disabled={!newEntryTitle.trim()} onClick={handleAddEntry}>
                    <Check size={12} /> Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => { setAddingEntry(false); setNewEntryTitle(''); setNewEntryBody('') }}>
                    <X size={12} /> Cancel
                  </Button>
                </div>
              </div>
            )}

            {activeEntries.length === 0 && !addingEntry && (
              <div className="text-center py-12 text-[13px] text-[#1A1A2E]/60">
                {isAdmin ? 'Nothing here yet. Click "Add entry" to start.' : 'Nothing here yet.'}
              </div>
            )}

            {activeEntries.map(entry => {
              const isEditing = entry.id === editingEntryId
              if (isEditing) {
                return (
                  <div key={entry.id} className="p-4 border-2 border-[#7F77DD] rounded-lg bg-white space-y-2">
                    <input value={editingEntryTitle} onChange={e => setEditingEntryTitle(e.target.value)} className={inputCls} />
                    <textarea value={editingEntryBody} onChange={e => setEditingEntryBody(e.target.value)} rows={5} className={`${inputCls} resize-y`} />
                    <div className="flex gap-2">
                      <Button size="sm" variant="teal" loading={busy} disabled={!editingEntryTitle.trim()} onClick={handleSaveEntry}>
                        <Check size={12} /> Save
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => { setEditingEntryId(null); setEditingEntryTitle(''); setEditingEntryBody('') }}>
                        <X size={12} /> Cancel
                      </Button>
                    </div>
                  </div>
                )
              }
              return (
                <div key={entry.id} className="group p-4 border border-[#E8E8E4] rounded-lg bg-white">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div className="font-medium text-[14px] text-[#1A1A2E] flex-1">{entry.title}</div>
                    {isAdmin && (
                      <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => { setEditingEntryId(entry.id); setEditingEntryTitle(entry.title); setEditingEntryBody(entry.body || '') }}
                          className="p-1 text-[#1A1A2E]/60 hover:text-[#7F77DD]"
                          title="Edit"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={() => handleDeleteEntry(entry.id)}
                          className="p-1 text-[#1A1A2E]/60 hover:text-[#991B1B]"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  {entry.body && (
                    <div className="text-[13px] text-[#1A1A2E]/85 whitespace-pre-wrap leading-relaxed">{entry.body}</div>
                  )}
                </div>
              )
            })}
          </main>
        </div>
      )}
    </div>
  )
}
