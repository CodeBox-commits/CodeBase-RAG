import type { CitationTarget } from '../components/CodeViewer'

// The question the home page's scroll stories follow, through the same made-up billing service the hero
// city is built from (sampleCity.ts). Fixed data, so every visit and every scroll position shows the same thing.

export const QUESTION = 'What happens when an invoice goes over its limit?'

export const PLAN = {
  type: 'behaviour',
  symbols: ['InvoiceService.finalize', 'invoice.limit'],
  queries: ['invoice total exceeds its limit', 'LimitExceeded raised when finalizing', 'finalize invoice and charge the customer'],
}

export const ROUTES = ['vector', 'hybrid', 'graph'] as const
export const ROUTE = 'hybrid' as const
export const ROUTE_REASON = 'A question about behaviour across a few symbols: vectors and keywords together, then one step through the graph.'

/** 24 signed values per query, standing in for the first numbers of each 384-number vector. */
export const VECTORS: number[][] = PLAN.queries.map((_, q) => {
  let seed = 7 + q * 31
  return Array.from({ length: 24 }, () => {
    seed = (seed * 1664525 + 1013904223) | 0
    return (((seed >>> 0) % 2000) / 1000 - 1) * (0.35 + 0.65 * Math.abs(Math.sin(seed)))
  })
})

export type Source = 'vector' | 'bm25'
export interface Candidate { symbol: string; file: string; sources: Source[] }

/** What vector search and BM25 found, merged by rank. */
export const CANDIDATES: Candidate[] = [
  { symbol: 'InvoiceService.finalize', file: 'billing/service.py', sources: ['vector', 'bm25'] },
  { symbol: 'check_totals', file: 'billing/rules.py', sources: ['vector'] },
  { symbol: 'Invoice.line_items', file: 'billing/models.py', sources: ['bm25'] },
  { symbol: 'InvoiceService._total', file: 'billing/service.py', sources: ['vector', 'bm25'] },
  { symbol: 'LimitExceeded', file: 'billing/errors.py', sources: ['bm25'] },
  { symbol: 'InvoiceService.validate', file: 'billing/service.py', sources: ['vector'] },
  { symbol: 'Cart.total', file: 'orders/cart.py', sources: ['vector'] },
  { symbol: 'checkout', file: 'api/checkout.py', sources: ['vector'] },
  { symbol: 'InvoiceService.apply_discounts', file: 'billing/service.py', sources: ['vector'] },
  { symbol: 'BaseService.validate', file: 'billing/base.py', sources: ['bm25'] },
  { symbol: 'StripeGateway.charge', file: 'payments/gateway.py', sources: ['vector'] },
  { symbol: 'rounding_policy', file: 'billing/rules.py', sources: ['vector'] },
  { symbol: 'Invoice.mark_paid', file: 'billing/models.py', sources: ['bm25'] },
  { symbol: 'tax_for_region', file: 'billing/rules.py', sources: ['vector'] },
  { symbol: 'confirm', file: 'api/checkout.py', sources: ['vector'] },
  { symbol: 'LineItem.subtotal', file: 'billing/models.py', sources: ['bm25'] },
  { symbol: 'revenue_by_month', file: 'reports/monthly.py', sources: ['vector'] },
  { symbol: 'cancel_order', file: 'api/checkout.py', sources: ['vector'] },
  { symbol: 'with_backoff', file: 'payments/retry.py', sources: ['vector'] },
  { symbol: 'InvoiceService.issue_refund', file: 'billing/service.py', sources: ['bm25'] },
  { symbol: 'Settings.from_env', file: 'core/config.py', sources: ['vector'] },
  { symbol: 'EventBus.publish', file: 'core/events.py', sources: ['bm25'] },
  { symbol: 'send_receipt', file: 'notify/email.py', sources: ['vector'] },
  { symbol: 'StripeGateway.refund', file: 'payments/gateway.py', sources: ['vector'] },
]

/** The cross-encoder's order for the first ten candidates (by their search position); the top 8 are kept. */
export const RERANKED = [0, 4, 3, 5, 7, 1, 2, 8, 6, 9]
export const KEEP = 8

export type Kind = 'function' | 'method' | 'class'
export interface GraphNode { id: string; kind: Kind; anchor?: boolean; x: number; y: number }
export interface GraphEdge { from: string; to: string; type: 'CALLS' | 'INHERITS' }

/** The graph walk: the top hits in the middle, their callers, callees and bases around them (viewBox 320 × 200). */
export const GRAPH_NODES: GraphNode[] = [
  { id: 'InvoiceService.finalize', kind: 'method', anchor: true, x: 160, y: 98 },
  { id: 'InvoiceService._total', kind: 'method', anchor: true, x: 108, y: 132 },
  { id: 'LimitExceeded', kind: 'class', anchor: true, x: 212, y: 132 },
  { id: 'InvoiceService.validate', kind: 'method', x: 84, y: 76 },
  { id: 'StripeGateway.charge', kind: 'method', x: 262, y: 56 },
  { id: 'Invoice.mark_paid', kind: 'method', x: 278, y: 100 },
  { id: 'EventBus.publish', kind: 'method', x: 196, y: 26 },
  { id: 'checkout', kind: 'function', x: 122, y: 30 },
  { id: 'confirm', kind: 'function', x: 36, y: 112 },
  { id: 'InvoiceService.issue_refund', kind: 'method', x: 70, y: 176 },
  { id: 'BaseService.validate', kind: 'method', x: 44, y: 40 },
  { id: 'BillingError', kind: 'class', x: 262, y: 172 },
]
export const GRAPH_EDGES: GraphEdge[] = [
  { from: 'checkout', to: 'InvoiceService.finalize', type: 'CALLS' },
  { from: 'confirm', to: 'InvoiceService.finalize', type: 'CALLS' },
  { from: 'InvoiceService.finalize', to: 'InvoiceService.validate', type: 'CALLS' },
  { from: 'InvoiceService.finalize', to: 'InvoiceService._total', type: 'CALLS' },
  { from: 'InvoiceService.finalize', to: 'LimitExceeded', type: 'CALLS' },
  { from: 'InvoiceService.finalize', to: 'StripeGateway.charge', type: 'CALLS' },
  { from: 'InvoiceService.finalize', to: 'Invoice.mark_paid', type: 'CALLS' },
  { from: 'InvoiceService.finalize', to: 'EventBus.publish', type: 'CALLS' },
  { from: 'InvoiceService.issue_refund', to: 'InvoiceService._total', type: 'CALLS' },
  { from: 'InvoiceService.validate', to: 'BaseService.validate', type: 'INHERITS' },
  { from: 'LimitExceeded', to: 'BillingError', type: 'INHERITS' },
]

/** Ask for more: what the model said it was missing, and what the exact lookup found. */
export const NEED = 'NEED: Invoice.limit'
export const FETCHED = { symbol: 'Invoice', file: 'billing/models.py', line: 12 }
export const CONTEXT_SUMMARY = 'Answering from 9 snippets in 4 files'

export const CITES = {
  total: { text: 'billing/service.py:45', filepath: 'billing/service.py', line: 45, end_line: 45, status: 'verified' },
  limit: { text: 'billing/service.py:46', filepath: 'billing/service.py', line: 46, end_line: 47, status: 'verified' },
  checkout: { text: 'api/checkout.py:88', filepath: 'api/checkout.py', line: 88, end_line: 88, status: 'graph' },
} satisfies Record<string, CitationTarget>

export type AnswerPart = { text: string } | { code: string } | { cite: CitationTarget }

/** The sample answer, a paragraph per array. */
export const ANSWER: AnswerPart[][] = [
  [
    { code: 'InvoiceService.finalize' }, { text: ' totals the invoice first ' }, { cite: CITES.total },
    { text: ', then raises ' }, { code: 'LimitExceeded' },
    { text: " with the invoice id and the total when it's over " }, { code: 'invoice.limit' }, { text: ' ' },
    { cite: CITES.limit }, { text: '. Nothing is charged.' },
  ],
  [{ text: 'The error reaches ' }, { code: 'checkout' }, { text: ', which cancels the order ' }, { cite: CITES.checkout }, { text: '.' }],
]

export const SAMPLE_CODE = `def finalize(self, invoice: Invoice) -> Charge:
    """Charge the customer for a validated invoice."""
    self.validate(invoice)
    total = self._total(invoice)
    if total > invoice.limit:
        raise LimitExceeded(invoice.id, total)
    charge = self.gateway.charge(invoice.customer, total)
    invoice.mark_paid(charge.id)
    self.events.publish("invoice.paid", invoice.id)
    return charge`
