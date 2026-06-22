import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { KeyRound, CheckCircle2, Phone } from 'lucide-react'
import { updatePassword } from 'aws-amplify/auth'
import { updateProvider } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

const schema = z.object({
  current_password: z.string().min(1, 'Required'),
  new_password: z.string().min(8, 'Must be at least 8 characters'),
  confirm_password: z.string().min(1, 'Required'),
}).refine(d => d.new_password === d.confirm_password, {
  message: "Passwords don't match",
  path: ['confirm_password'],
})
type FormData = z.infer<typeof schema>

export function Settings() {
  const { provider } = useAuth()
  const [success, setSuccess] = useState(false)
  const [serverError, setServerError] = useState('')
  const [phone, setPhone] = useState((provider as any)?.phone || '')
  const [phoneSaved, setPhoneSaved] = useState(false)
  const [phoneSaving, setPhoneSaving] = useState(false)
  const [phoneError, setPhoneError] = useState('')
  const [secureText, setSecureText] = useState((provider as any)?.secure_text_number || '')
  const [secureTextSaved, setSecureTextSaved] = useState(false)
  const [secureTextSaving, setSecureTextSaving] = useState(false)
  const [secureTextError, setSecureTextError] = useState('')

  async function savePhone() {
    if (!provider) return
    setPhoneSaving(true)
    setPhoneError('')
    try {
      await updateProvider(provider.id, { phone: phone || null })
      setPhoneSaved(true)
      setTimeout(() => setPhoneSaved(false), 2500)
    } catch (e: any) {
      setPhoneError(e.message ?? 'Failed to save')
    } finally {
      setPhoneSaving(false)
    }
  }

  async function saveSecureText() {
    if (!provider) return
    setSecureTextSaving(true)
    setSecureTextError('')
    try {
      await updateProvider(provider.id, { secure_text_number: secureText || null })
      setSecureTextSaved(true)
      setTimeout(() => setSecureTextSaved(false), 2500)
    } catch (e: any) {
      setSecureTextError(e.message ?? 'Failed to save')
    } finally {
      setSecureTextSaving(false)
    }
  }

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    setServerError('')
    try {
      await updatePassword({ oldPassword: data.current_password, newPassword: data.new_password })
      setSuccess(true)
      reset()
      setTimeout(() => setSuccess(false), 4000)
    } catch (e: any) {
      setServerError(e.message ?? 'Failed to update password')
    }
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Settings</div>
      </div>

      <div className="p-6 max-w-sm space-y-4">

        {/* Phone for SMS notifications */}
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Phone size={16} className="text-[#7F77DD]" />
            <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">SMS notifications</h2>
          </div>
          <p className="text-[12px] text-[#999] mb-4">Add your mobile number to receive a text message when a new appointment is added to your schedule. Include the country code — e.g. <strong>+17045551234</strong></p>
          <div className="space-y-3">
            <Input label="Mobile number" type="tel" placeholder="(704) 000-0000"
              value={phone} onChange={e => setPhone(e.target.value)} />
            {phoneSaved && <div className="flex items-center gap-2 text-[13px] text-[#085041]"><CheckCircle2 size={14} /> Saved!</div>}
            {phoneError && <div className="text-[13px] text-[#791F1F]">{phoneError}</div>}
            <Button size="sm" loading={phoneSaving} onClick={savePhone}>Save number</Button>
          </div>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Phone size={16} className="text-[#1D9E75]" />
            <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Secure texting number</h2>
          </div>
          <p className="text-[12px] text-[#999] mb-4">Your secure texting number is shared with families who are outside our current service zones so they can reach you directly. Include the country code — e.g. <strong>+17045551234</strong></p>
          <div className="space-y-3">
            <Input label="Secure text number" type="tel" placeholder="(704) 000-0000"
              value={secureText} onChange={e => setSecureText(e.target.value)} />
            {secureTextSaved && <div className="flex items-center gap-2 text-[13px] text-[#085041]"><CheckCircle2 size={14} /> Saved!</div>}
            {secureTextError && <div className="text-[13px] text-[#791F1F]">{secureTextError}</div>}
            <Button size="sm" loading={secureTextSaving} onClick={saveSecureText}>Save number</Button>
          </div>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <KeyRound size={16} className="text-[#7F77DD]" />
            <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Change password</h2>
          </div>

          {provider && (
            <div className="mb-4 p-3 bg-[#FAFAF8] rounded-lg text-[13px] text-[#555]">
              Signed in as <strong className="text-[#1A1A2E]">{provider.name}</strong>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input
              label="Current password"
              type="password"
              placeholder="••••••••"
              error={errors.current_password?.message}
              {...register('current_password')}
            />
            <Input
              label="New password"
              type="password"
              placeholder="8+ characters"
              error={errors.new_password?.message}
              {...register('new_password')}
            />
            <Input
              label="Confirm new password"
              type="password"
              placeholder="••••••••"
              error={errors.confirm_password?.message}
              {...register('confirm_password')}
            />

            {serverError && (
              <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{serverError}</div>
            )}

            {success && (
              <div className="p-3 rounded-lg bg-[#E1F5EE] text-[13px] text-[#085041] flex items-center gap-2">
                <CheckCircle2 size={14} /> Password updated successfully
              </div>
            )}

            <Button type="submit" size="sm" loading={isSubmitting}>
              Update password
            </Button>
          </form>
        </div>
      </div>

    </div>
  )
}
