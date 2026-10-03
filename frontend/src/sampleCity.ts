import type { CityEdge, CityNode } from './components/CodeCity'

// A made-up but plausible repository for the home page city, so it reads like real code on hover.
// Deterministic, so the skyline is the same on every visit.

const FILES: Record<string, [string, string[]][]> = {
  'billing/service.py': [['InvoiceService', ['finalize', 'validate', 'apply_discounts', 'issue_refund', '_total']]],
  'billing/models.py': [['Invoice', ['line_items', 'mark_paid']], ['LineItem', ['subtotal']]],
  'billing/rules.py': [['', ['check_totals', 'tax_for_region', 'rounding_policy']]],
  'billing/base.py': [['BaseService', ['validate', 'log_event']]],
  'payments/gateway.py': [['StripeGateway', ['charge', 'refund', 'webhook', '_sign']]],
  'payments/retry.py': [['', ['with_backoff', 'is_retryable']]],
  'api/checkout.py': [['', ['checkout', 'confirm', 'cancel_order']]],
  'api/routes.py': [['', ['register_routes', 'health', 'ready']]],
  'api/auth.py': [['TokenAuth', ['verify', 'refresh', 'revoke']]],
  'orders/cart.py': [['Cart', ['add', 'remove', 'total', 'clear']]],
  'orders/fulfilment.py': [['Fulfilment', ['ship', 'track', 'notify_customer']]],
  'orders/inventory.py': [['', ['reserve', 'release', 'stock_level']]],
  'core/config.py': [['Settings', ['from_env']]],
  'core/db.py': [['', ['session', 'transaction', 'migrate']]],
  'core/events.py': [['EventBus', ['publish', 'subscribe']]],
  'notify/email.py': [['', ['send_receipt', 'send_shipping_update', 'render_template']]],
  'notify/sms.py': [['', ['send_sms']]],
  'reports/monthly.py': [['', ['revenue_by_month', 'export_csv', 'top_customers']]],
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) | 0
    return ((seed >>> 0) % 10000) / 10000
  }
}

export function sampleCity(): { nodes: CityNode[]; edges: CityEdge[] } {
  const rand = rng(11)
  const nodes: CityNode[] = []
  const edges: CityEdge[] = []
  Object.entries(FILES).forEach(([file, groups]) => {
    groups.forEach(([cls, fns]) => {
      const members = fns.map((fn) => ({
        id: cls ? `${cls}.${fn}` : `${file.replace(/\.py$/, '').replace('/', '.')}.${fn}`,
        name: cls ? `${cls}.${fn}` : fn,
        kind: cls ? 'method' : 'function',
        filepath: file,
        lines: Math.round(4 + rand() * rand() * 70),
      }))
      if (cls) {
        const id = cls
        nodes.push({ id, name: cls, kind: 'class', filepath: file, lines: members.reduce((s, m) => s + m.lines, 8) })
        members.forEach((m) => edges.push({ source: id, target: m.id, type: 'HAS_METHOD' }))
      }
      nodes.push(...members)
    })
  })
  const callable = nodes.filter((n) => n.kind !== 'class')
  const pick = () => callable[Math.floor(rand() * callable.length)]
  // A few real-looking chains first, then sparse random calls.
  const chain = (...ids: string[]) => ids.slice(1).forEach((id, i) => edges.push({ source: ids[i], target: id, type: 'CALLS' }))
  chain('api.checkout.checkout', 'Cart.total', 'InvoiceService.finalize', 'BaseService.validate', 'billing.rules.check_totals')
  chain('InvoiceService.finalize', 'StripeGateway.charge', 'payments.retry.with_backoff')
  chain('InvoiceService.finalize', 'notify.email.send_receipt', 'notify.email.render_template')
  chain('api.checkout.confirm', 'Fulfilment.ship', 'orders.inventory.reserve', 'core.db.transaction')
  chain('InvoiceService.issue_refund', 'StripeGateway.refund', 'EventBus.publish')
  edges.push({ source: 'InvoiceService', target: 'BaseService', type: 'INHERITS' })
  for (let i = 0; i < 60; i++) {
    const a = pick(), b = pick()
    if (a.id !== b.id) edges.push({ source: a.id, target: b.id, type: 'CALLS' })
  }
  return { nodes, edges }
}
