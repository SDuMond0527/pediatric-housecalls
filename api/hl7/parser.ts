// HL7 v2 ORU^R01 (result) message parser — transport-agnostic.
// Pure function, no I/O, no auth. Call from any endpoint (webhook,
// SFTP cron, MLLP listener) once we know how LabCorp will deliver.
//
// Spec reference: HL7 v2.3 — https://hl7-definition.caristix.com/v2/HL7v2.3/TriggerEvents/ORU_R01
// We handle the common subset LabCorp emits in practice.
// Sara 2026-11-17.

// ── Delimiters ───────────────────────────────────────────────────────────
// Declared in the MSH segment itself: `MSH|^~\&|...`
// The second character after "MSH" is the field separator (nearly always "|").
// The next four characters (encoding chars) are component, repetition,
// escape, subcomponent. LabCorp follows the HL7 defaults.
interface Delim {
  field: string
  component: string
  repetition: string
  escape: string
  subcomponent: string
}

const DEFAULT_DELIMS: Delim = { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&' }

// ── Raw segment structure ────────────────────────────────────────────────
export interface RawSegment {
  name: string              // 'MSH' | 'PID' | 'OBR' | 'OBX' | 'NTE' | 'ORC' | 'PV1' | …
  fields: string[]          // ['MSH', '^~\\&', 'LAB', 'LABCORP', …]
}

// ── Parsed domain objects ────────────────────────────────────────────────
export interface ParsedPatient {
  mrn: string | null                  // PID-3 primary ID
  altIds: string[]                    // PID-3 repeating IDs beyond the first
  lastName: string | null             // PID-5 component 1
  firstName: string | null            // PID-5 component 2
  middleName: string | null           // PID-5 component 3
  dateOfBirth: string | null          // PID-7 as "YYYY-MM-DD" (parsed from YYYYMMDD)
  sex: 'M' | 'F' | 'O' | 'U' | null   // PID-8
  address: {
    street: string | null             // PID-11 component 1
    city: string | null               // component 3
    state: string | null              // component 4
    zip: string | null                // component 5
  }
  phone: string | null                // PID-13 component 1
}

export interface ParsedOrderingProvider {
  npi: string | null                  // OBR-16 component 1 or ORC-12 component 1
  lastName: string | null             // component 2
  firstName: string | null            // component 3
}

export interface ParsedOrder {
  placerOrderNumber: string | null    // OBR-2 — the requisition number
  fillerOrderNumber: string | null    // OBR-3 — LabCorp's internal ID
  testCode: string | null             // OBR-4 component 1 (e.g. "005009")
  testName: string | null             // OBR-4 component 2 (e.g. "CBC with Differential")
  collectionDateTime: string | null   // OBR-7 as ISO-ish (parsed from YYYYMMDDHHMMSS)
  observationDateTime: string | null  // OBR-7 (fallback OBR-22)
  orderingProvider: ParsedOrderingProvider
  results: ParsedResult[]             // OBX children for this OBR
  notes: string[]                     // NTE children (free-text comments)
}

export interface ParsedResult {
  setId: string                       // OBX-1
  valueType: string                   // OBX-2 (NM, ST, TX, CE, …)
  identifier: {
    code: string | null               // OBX-3 component 1 (LOINC or LabCorp-internal)
    name: string | null               // component 2
    codingSystem: string | null       // component 3 (LN, L, …)
  }
  value: string | null                // OBX-5 (joined if multiple components)
  units: string | null                // OBX-6 component 1
  referenceRange: string | null       // OBX-7
  abnormalFlags: string | null        // OBX-8 (N, H, L, HH, LL, A, …)
  status: string | null               // OBX-11 (F=final, P=preliminary, C=corrected)
  observationDateTime: string | null  // OBX-14
  producerId: string | null           // OBX-15 (performing lab)
  performingProvider: string | null   // OBX-16
  notes: string[]                     // NTE children attached to this OBX
}

export interface ParsedOru {
  messageControlId: string | null     // MSH-10
  sendingApplication: string | null   // MSH-3 (e.g. "LABCORP")
  sendingFacility: string | null      // MSH-4
  receivingApplication: string | null // MSH-5
  receivingFacility: string | null    // MSH-6 (LabCorp often puts the account # here)
  messageDateTime: string | null      // MSH-7
  messageType: string | null          // MSH-9 (e.g. "ORU^R01")
  version: string | null              // MSH-12

  patient: ParsedPatient | null
  orders: ParsedOrder[]
  // Any segments we didn't model — surfaced for debugging and future
  // extension without silently losing data.
  unknownSegments: RawSegment[]
  // Parse-time warnings (non-fatal). Useful in the dry-run UI.
  warnings: string[]
}

// ── Low-level: tokenize a raw HL7 string ─────────────────────────────────
function detectDelims(firstSegment: string): Delim {
  // MSH has a special form: the field separator is the first char AFTER
  // "MSH". The 4 encoding chars are MSH-2 as a literal field.
  if (!firstSegment.startsWith('MSH')) return DEFAULT_DELIMS
  const field = firstSegment.charAt(3) || '|'
  const enc   = firstSegment.slice(4, 8) || '^~\\&'
  return {
    field,
    component:    enc.charAt(0) || '^',
    repetition:   enc.charAt(1) || '~',
    escape:       enc.charAt(2) || '\\',
    subcomponent: enc.charAt(3) || '&',
  }
}

function splitSegments(message: string): string[] {
  // LabCorp and most vendors use CR (\r) as segment terminator but real
  // files travel over SMTP / HTTP where \n sneaks in. Accept both.
  return message
    .replace(/\r\n/g, '\r')
    .replace(/\n/g, '\r')
    .split('\r')
    .map(s => s.trim())
    .filter(Boolean)
}

function tokenizeSegment(raw: string, delims: Delim): RawSegment {
  const fields = raw.split(delims.field)
  const name = fields[0] ?? ''
  return { name, fields }
}

// Pull a single field value from a segment, returning null for empty.
// field indexes are 1-based per HL7 convention (MSH-3 = index 3), but
// because MSH has an off-by-one (field separator itself counts as field
// 1 in the HL7 spec), callers should use `getField(seg, idx)` directly
// against the tokenized array where `fields[0]` is the segment name.
function rawField(seg: RawSegment, idx: number): string | null {
  const v = seg.fields[idx]
  if (v === undefined) return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

function components(value: string | null, delims: Delim): string[] {
  if (!value) return []
  return value.split(delims.component)
}

function firstComponent(value: string | null, delims: Delim): string | null {
  const parts = components(value, delims)
  return parts[0] ?? null
}

function component(value: string | null, delims: Delim, idx: number): string | null {
  const parts = components(value, delims)
  const v = parts[idx] ?? null
  return (v && v.trim()) ? v.trim() : null
}

// HL7 dates: YYYYMMDD or YYYYMMDDHHMM or YYYYMMDDHHMMSS (+/-HHMM tz optional).
function parseHl7DateTime(raw: string | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length < 8) return null
  const yyyy = digits.slice(0, 4)
  const mm   = digits.slice(4, 6)
  const dd   = digits.slice(6, 8)
  if (digits.length === 8) return `${yyyy}-${mm}-${dd}`
  const hh  = digits.slice(8, 10) || '00'
  const mi  = digits.slice(10, 12) || '00'
  const ss  = digits.slice(12, 14) || '00'
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`
}

// ── Segment-level parsers ────────────────────────────────────────────────
function parseMsh(seg: RawSegment, delims: Delim, out: ParsedOru): void {
  // MSH is unusual: field separator is baked in, so MSH-3 lives at
  // fields[2] from our tokenization (MSH|^~\&|APP|FAC|…)
  out.sendingApplication   = rawField(seg, 2)
  out.sendingFacility      = rawField(seg, 3)
  out.receivingApplication = rawField(seg, 4)
  out.receivingFacility    = rawField(seg, 5)
  out.messageDateTime      = parseHl7DateTime(rawField(seg, 6))
  out.messageType          = rawField(seg, 8)
  out.messageControlId     = rawField(seg, 9)
  out.version              = rawField(seg, 11)
  // sanity
  if (out.messageType && !out.messageType.startsWith('ORU')) {
    out.warnings.push(`Expected ORU message, got ${out.messageType}`)
  }
}

function parsePid(seg: RawSegment, delims: Delim): ParsedPatient {
  const idField = rawField(seg, 3)
  const ids = idField
    ? idField.split(delims.repetition).map(id => firstComponent(id, delims)).filter((v): v is string => !!v)
    : []
  const name = rawField(seg, 5)
  const address = rawField(seg, 11)
  const phone = rawField(seg, 13)
  const sex = (rawField(seg, 8) ?? '').toUpperCase()
  return {
    mrn: ids[0] ?? null,
    altIds: ids.slice(1),
    lastName:  component(name, delims, 0),
    firstName: component(name, delims, 1),
    middleName: component(name, delims, 2),
    dateOfBirth: parseHl7DateTime(rawField(seg, 7)),
    sex: sex === 'M' || sex === 'F' || sex === 'O' || sex === 'U' ? sex : null,
    address: {
      street: component(address, delims, 0),
      city:   component(address, delims, 2),
      state:  component(address, delims, 3),
      zip:    component(address, delims, 4),
    },
    phone: firstComponent(phone, delims),
  }
}

function parseProvider(raw: string | null, delims: Delim): ParsedOrderingProvider {
  return {
    npi:       component(raw, delims, 0),
    lastName:  component(raw, delims, 1),
    firstName: component(raw, delims, 2),
  }
}

function parseObr(seg: RawSegment, delims: Delim): ParsedOrder {
  const testField = rawField(seg, 4)
  const provider = parseProvider(rawField(seg, 16) ?? rawField(seg, 10), delims)
  return {
    placerOrderNumber: firstComponent(rawField(seg, 2), delims),
    fillerOrderNumber: firstComponent(rawField(seg, 3), delims),
    testCode: component(testField, delims, 0),
    testName: component(testField, delims, 1),
    collectionDateTime: parseHl7DateTime(rawField(seg, 7)),
    observationDateTime: parseHl7DateTime(rawField(seg, 22) ?? rawField(seg, 14)),
    orderingProvider: provider,
    results: [],
    notes: [],
  }
}

function parseObx(seg: RawSegment, delims: Delim): ParsedResult {
  const ident = rawField(seg, 3)
  // OBX-5 can repeat; take the whole field, with components joined so we
  // don't lose data.
  const rawValue = rawField(seg, 5)
  const value = rawValue ? rawValue.replace(new RegExp(`\\${delims.component}`, 'g'), ' ') : null
  return {
    setId: rawField(seg, 1) ?? '',
    valueType: rawField(seg, 2) ?? '',
    identifier: {
      code:         component(ident, delims, 0),
      name:         component(ident, delims, 1),
      codingSystem: component(ident, delims, 2),
    },
    value,
    units: firstComponent(rawField(seg, 6), delims),
    referenceRange: rawField(seg, 7),
    abnormalFlags: rawField(seg, 8),
    status: rawField(seg, 11),
    observationDateTime: parseHl7DateTime(rawField(seg, 14)),
    producerId: firstComponent(rawField(seg, 15), delims),
    performingProvider: firstComponent(rawField(seg, 16), delims),
    notes: [],
  }
}

function parseNte(seg: RawSegment): string | null {
  // NTE-3 is the free-text comment. Multiple NTEs can chain to build
  // multi-line notes; we flatten to one line per segment.
  const text = seg.fields[3]
  return text ? text.trim() : null
}

// ── Public entry point ──────────────────────────────────────────────────
export function parseHl7Oru(message: string): ParsedOru {
  const out: ParsedOru = {
    messageControlId: null,
    sendingApplication: null,
    sendingFacility: null,
    receivingApplication: null,
    receivingFacility: null,
    messageDateTime: null,
    messageType: null,
    version: null,
    patient: null,
    orders: [],
    unknownSegments: [],
    warnings: [],
  }

  const segments = splitSegments(message)
  if (segments.length === 0) {
    out.warnings.push('No segments found — empty or invalid message.')
    return out
  }

  const delims = detectDelims(segments[0])
  const tokens = segments.map(s => tokenizeSegment(s, delims))

  let currentOrder: ParsedOrder | null = null
  let currentObxIndex = -1

  for (const seg of tokens) {
    switch (seg.name) {
      case 'MSH':
        parseMsh(seg, delims, out)
        break
      case 'PID':
        out.patient = parsePid(seg, delims)
        break
      case 'OBR':
        currentOrder = parseObr(seg, delims)
        currentObxIndex = -1
        out.orders.push(currentOrder)
        break
      case 'OBX': {
        if (!currentOrder) {
          out.warnings.push('OBX segment with no preceding OBR — skipped.')
          break
        }
        const result = parseObx(seg, delims)
        currentOrder.results.push(result)
        currentObxIndex = currentOrder.results.length - 1
        break
      }
      case 'NTE': {
        const text = parseNte(seg)
        if (!text) break
        if (currentOrder && currentObxIndex >= 0) {
          currentOrder.results[currentObxIndex].notes.push(text)
        } else if (currentOrder) {
          currentOrder.notes.push(text)
        }
        break
      }
      case 'ORC':
      case 'PV1':
      case 'PID2':
      case 'NK1':
      case 'IN1':
      case 'IN2':
      case 'ZPS':
      case 'ZDS':
        // Known but unmodeled — intentional pass. Can promote fields
        // later when a specific LabCorp message type needs them.
        break
      default:
        out.unknownSegments.push(seg)
    }
  }

  // Post-parse sanity.
  if (!out.patient) out.warnings.push('No PID segment found — patient matching will not run.')
  if (out.orders.length === 0) out.warnings.push('No OBR segments — nothing to ingest.')

  return out
}
