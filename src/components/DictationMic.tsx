import { useRef, useState } from 'react'
import { Mic, Square, Loader2 } from 'lucide-react'
import { fetchAuthSession } from 'aws-amplify/auth'

// Per-field voice dictation button. Click to start recording, click again
// to stop + transcribe. Transcript is appended (not replaced) to whatever
// is already in the field. Sara 2026-11-09 — dictation tier of the
// AI-scribe plan, Deepgram nova-2-medical model behind /api/transcribe-
// dictation.

type Status = 'idle' | 'recording' | 'processing' | 'error'

export function DictationMic({ onTranscript, disabled, label }: {
  /** Called with the transcribed text after the recording finishes. */
  onTranscript: (text: string) => void
  disabled?: boolean
  /** Field name for the ARIA label — e.g. "Dictate chief complaint". */
  label: string
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  function cleanupStream() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }

  async function startRecording() {
    setErrorMsg('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setErrorMsg('This browser does not support microphone recording.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      // Let the browser pick its best supported container. Chrome gives
      // webm/opus, Safari gives mp4/aac. Deepgram's content-type sniffer
      // handles both.
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : ''
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      recorderRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => { void sendForTranscription(rec.mimeType) }
      rec.start()
      setStatus('recording')
    } catch (e: any) {
      cleanupStream()
      setStatus('error')
      // Permission-denied is the overwhelming case; distinguish it so the
      // user sees an actionable message.
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        setErrorMsg('Microphone permission denied. Allow mic access in your browser settings.')
      } else {
        setErrorMsg(e?.message ?? 'Failed to start recording.')
      }
    }
  }

  function stopRecording() {
    const rec = recorderRef.current
    if (!rec) return
    if (rec.state !== 'inactive') rec.stop()
    setStatus('processing')
  }

  async function sendForTranscription(mimeType: string) {
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
      cleanupStream()
      if (blob.size === 0) {
        setStatus('idle')
        return
      }
      const session = await fetchAuthSession()
      const token = session.tokens?.idToken?.toString() ?? session.tokens?.accessToken?.toString()
      if (!token) throw new Error('Not signed in — reload and try again.')
      const res = await fetch('/api/transcribe-dictation', {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          Authorization: `Bearer ${token}`,
        },
        body: blob,
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || `Transcription failed (${res.status})`)
      }
      const data = await res.json()
      const text: string = (data?.transcript ?? '').trim()
      if (text) onTranscript(text)
      setStatus('idle')
    } catch (e: any) {
      cleanupStream()
      setStatus('error')
      setErrorMsg(e?.message ?? 'Transcription failed.')
    }
  }

  const isBusy = status === 'recording' || status === 'processing'

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          if (status === 'recording') stopRecording()
          else if (status !== 'processing') startRecording()
        }}
        disabled={disabled || status === 'processing'}
        aria-label={label}
        title={
          status === 'recording' ? 'Stop recording'
            : status === 'processing' ? 'Transcribing…'
            : label
        }
        className={`inline-flex items-center justify-center h-6 w-6 rounded-full border transition-colors ${
          status === 'recording'
            ? 'bg-[#DC2626] text-white border-[#DC2626] animate-pulse'
            : status === 'processing'
              ? 'bg-[#F1EFE8] text-[#555] border-[#E8E8E4]'
              : 'bg-white text-[#555] border-[#E8E8E4] hover:bg-[#F1EFE8]'
        } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {status === 'recording'
          ? <Square size={12} />
          : status === 'processing'
            ? <Loader2 size={12} className="animate-spin" />
            : <Mic size={12} />}
      </button>
      {status === 'error' && errorMsg && (
        <span className="text-[10px] text-[#DC2626] leading-snug">{errorMsg}</span>
      )}
      {isBusy && (
        <span className="text-[10px] text-[#555]">
          {status === 'recording' ? 'Recording…' : 'Transcribing…'}
        </span>
      )}
    </span>
  )
}

/** Append a dictated chunk to existing field content with a sensible
 *  separator — space between sentences, no leading whitespace. */
export function appendDictation(prev: string, chunk: string): string {
  const base = prev ?? ''
  const addition = chunk.trim()
  if (!addition) return base
  if (!base) return addition
  const trailing = base.slice(-1)
  const needsSpace = !/[\s\n]/.test(trailing)
  return base + (needsSpace ? ' ' : '') + addition
}
