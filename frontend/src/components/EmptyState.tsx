import { Button } from '@/components/ui/button'
import { navigate, type Route } from '../router'
import MiniCity from './MiniCity'

/** A page with nothing to show yet: say why, and offer the one thing that fixes it. */
export default function EmptyState({ title, body, action }: { title: string; body: string; action?: { label: string; to: Route } }) {
  return (
    <div className="grid min-h-[calc(100svh-3.5rem)] place-items-center px-6 py-16">
      <div className="max-w-md text-center">
        <MiniCity className="mx-auto h-32 w-44" />
        <h1 className="display mt-6 text-[2.6rem]">{title}</h1>
        <p className="mt-3 text-muted-foreground">{body}</p>
        {action && <Button className="mt-6" size="lg" onClick={() => navigate(action.to)}>{action.label}</Button>}
      </div>
    </div>
  )
}
