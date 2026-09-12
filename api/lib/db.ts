import { neon } from '@neondatabase/serverless'
import type { NeonQueryFunction } from '@neondatabase/serverless'

let _client: NeonQueryFunction<false, false> | null = null

function getClient(): NeonQueryFunction<false, false> {
  if (!_client) _client = neon(process.env.DATABASE_URL!)
  return _client
}

// Proxy so existing sql`...` tagged-template syntax works unchanged,
// but neon() is only called inside a request handler (never at module load time).
const sql = new Proxy(function () {} as unknown as NeonQueryFunction<false, false>, {
  apply(_t, _this, args) {
    return (getClient() as unknown as (...a: unknown[]) => unknown).apply(null, args)
  },
}) as NeonQueryFunction<false, false>

export default sql
