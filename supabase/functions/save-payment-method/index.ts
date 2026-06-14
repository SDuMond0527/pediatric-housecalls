import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const SQUARE_TOKEN = Deno.env.get('SQUARE_ACCESS_TOKEN') || ''
const SQUARE_ENV   = Deno.env.get('SQUARE_ENVIRONMENT') || 'sandbox'
const SQUARE_BASE  = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com'

async function squarePost(path: string, body: unknown) {
  const res = await fetch(`${SQUARE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SQUARE_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-17',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) {
    const detail = json.errors?.[0]?.detail || json.errors?.[0]?.category || 'Square API error'
    throw new Error(detail)
  }
  return json
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { familyId, nonce } = await req.json()
    if (!familyId || !nonce) throw new Error('Missing familyId or nonce')

    // Load family profile
    const { data: family } = await supabase
      .from('family_profiles')
      .select('id, email, display_name, square_customer_id')
      .eq('id', familyId)
      .single()
    if (!family) throw new Error('Family not found')

    // Create Square customer if this is their first card
    let customerId = family.square_customer_id as string | null
    if (!customerId) {
      const nameParts = (family.display_name || '').trim().split(/\s+/)
      const { customer } = await squarePost('/v2/customers', {
        given_name:   nameParts[0] || 'Family',
        family_name:  nameParts.slice(1).join(' ') || '',
        email_address: family.email,
        reference_id: family.id,
      })
      customerId = customer.id as string
    }

    // Save the card on file
    const { card } = await squarePost('/v2/cards', {
      idempotency_key: crypto.randomUUID(),
      source_id: nonce,
      card: { customer_id: customerId },
    })

    // Persist IDs
    await supabase.from('family_profiles').update({
      square_customer_id: customerId,
      square_card_id:     card.id,
    }).eq('id', familyId)

    return new Response(JSON.stringify({ ok: true, cardBrand: card.card_brand, last4: card.last_4 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('save-payment-method error:', err)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
