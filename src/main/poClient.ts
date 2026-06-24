import type { PoApiOrder } from '@shared/types'

// Pure HTTP client for the PO Automation read-only reconciliation API. Kept free
// of any Electron / better-sqlite3 dependency on purpose: (1) single responsibility,
// (2) it can be unit-tested under plain Node (the native sqlite module is built for
// Electron's ABI and won't load outside it). Network egress for the whole feature
// flows through here, from the Electron main process.

export class PoApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PoApiError'
    this.status = status
  }
}

interface OrdersPage {
  orders: PoApiOrder[]
  nextCursor: string | null
}

function ordersUrl(baseUrl: string, params: Record<string, string>): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const url = new URL(`${base}/api/reconciliation/orders`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function fetchPage(baseUrl: string, token: string, params: Record<string, string>): Promise<OrdersPage> {
  let res: Response
  try {
    res = await fetch(ordersUrl(baseUrl, params), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    throw new PoApiError(`Could not reach the PO system at ${baseUrl}. Check the URL and your connection.`, 0)
  }
  if (res.status === 401) throw new PoApiError('The PO system rejected the API token. Double-check the token.', 401)
  if (res.status === 503)
    throw new PoApiError(
      'The PO system has reconciliation disabled (RECONCILIATION_API_TOKEN is not set on the server).',
      503
    )
  if (!res.ok) throw new PoApiError(`The PO system returned HTTP ${res.status}.`, res.status)

  const json = (await res.json().catch(() => null)) as { orders?: unknown; nextCursor?: unknown } | null
  if (!json || !Array.isArray(json.orders)) {
    throw new PoApiError('The PO system returned an unexpected response.', res.status)
  }
  return {
    orders: json.orders as PoApiOrder[],
    nextCursor: typeof json.nextCursor === 'string' ? json.nextCursor : null
  }
}

/** Fetch a single PO to confirm the URL + token work. Returns how many came back (0 or 1). */
export async function probe(baseUrl: string, token: string): Promise<number> {
  const { orders } = await fetchPage(baseUrl, token, { limit: '1' })
  return orders.length
}

/** Walk every page of the orders feed, following the cursor until exhausted. */
export async function fetchAllOrders(
  baseUrl: string,
  token: string,
  opts: { vendor?: string; pageSize?: number } = {}
): Promise<PoApiOrder[]> {
  const all: PoApiOrder[] = []
  const pageSize = String(opts.pageSize ?? 500)
  let cursor: string | null = null

  // Safety cap: 1000 pages * 500 = 500k POs, far beyond any real dataset.
  for (let page = 0; page < 1000; page++) {
    const params: Record<string, string> = { limit: pageSize }
    if (opts.vendor) params.vendor = opts.vendor
    if (cursor) params.cursor = cursor

    const { orders, nextCursor } = await fetchPage(baseUrl, token, params)
    all.push(...orders)
    if (!nextCursor || orders.length === 0) break
    cursor = nextCursor
  }
  return all
}
