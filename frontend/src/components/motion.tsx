import { motion, useMotionValue, useReducedMotion, useSpring, type Variants } from 'motion/react'
import { Fragment, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// The app's motion kit: headlines that rise word by word, pages that build themselves, cards that tilt
// toward the cursor and buttons that lean into it. Reduced motion keeps the fades and drops the rest.

const EASE = [0.2, 0.7, 0.2, 1] as const

const words: Variants = {
  hidden: { y: '110%' },
  show: (i: number) => ({ y: '0%', transition: { duration: 0.7, ease: EASE, delay: i } }),
}

/** A headline whose words rise into place one after another, each from behind its own mask. */
export function RevealText({ text, as = 'h1', className, delay = 0.1 }: { text: string; as?: 'h1' | 'h2' | 'p'; className?: string; delay?: number }) {
  const Tag = motion[as]
  const reduce = useReducedMotion()
  const list = text.split(' ')
  return (
    <Tag className={className} initial={reduce ? false : 'hidden'} animate="show" aria-label={text}>
      {list.map((word, i) => (
        <Fragment key={i}>
          {/* The mask's padding gives descenders (g, y, p) room; the negative margin keeps the line height.
              The space goes between masks: a trailing space inside one would be dropped. */}
          <span aria-hidden className="-mb-[0.14em] inline-block overflow-hidden pb-[0.14em] align-top">
            <motion.span className="inline-block" variants={words} custom={delay + i * 0.06}>
              {word}
            </motion.span>
          </span>
          {i < list.length - 1 && ' '}
        </Fragment>
      ))}
    </Tag>
  )
}

const group: Variants = { hidden: {}, show: (delay: number = 0.15) => ({ transition: { staggerChildren: 0.08, delayChildren: delay } }) }
const FROM = { up: { y: 28 }, down: { y: -24 }, left: { x: -36 }, right: { x: 36 } }

/** Plays its `Rise` children in one after another when it mounts. */
export function RiseGroup({ children, className, delay, as = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' | 'ul' }) {
  const Tag = motion[as]
  return (
    <Tag className={className} initial="hidden" animate="show" variants={group} custom={delay}>
      {children}
    </Tag>
  )
}

/** One block of a page building itself: it fades in from a short way off (`from`), in its group's turn. */
export function Rise({ children, className, from = 'up', as = 'div' }: { children: ReactNode; className?: string; from?: keyof typeof FROM; as?: 'div' | 'li' | 'section' | 'aside' }) {
  const Tag = motion[as]
  const variants: Variants = {
    hidden: { opacity: 0, ...FROM[from] },
    show: { opacity: 1, x: 0, y: 0, transition: { duration: 0.6, ease: EASE } },
  }
  return <Tag className={className} variants={variants}>{children}</Tag>
}

const SPRING = { stiffness: 260, damping: 22, mass: 0.6 }

/** Tilts toward the cursor in 3D, a few degrees at most, and settles back when it leaves. */
export function Tilt({ children, className, max = 5 }: { children: ReactNode; className?: string; max?: number }) {
  const reduce = useReducedMotion()
  const rx = useSpring(useMotionValue(0), SPRING)
  const ry = useSpring(useMotionValue(0), SPRING)
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    ry.set(((e.clientX - r.left) / r.width - 0.5) * 2 * max)
    rx.set(-((e.clientY - r.top) / r.height - 0.5) * 2 * max)
  }
  const leave = () => { rx.set(0); ry.set(0) }
  return (
    <motion.div className={cn('[transform-style:preserve-3d]', className)} style={{ rotateX: rx, rotateY: ry, transformPerspective: 1200 }} onPointerMove={move} onPointerLeave={leave}>
      {children}
    </motion.div>
  )
}

/** Leans toward the cursor while it's over it (a quarter of the way), and springs back when it leaves. */
export function Magnetic({ children, className, pull = 0.25 }: { children: ReactNode; className?: string; pull?: number }) {
  const reduce = useReducedMotion()
  const x = useSpring(useMotionValue(0), SPRING)
  const y = useSpring(useMotionValue(0), SPRING)
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    x.set((e.clientX - (r.left + r.width / 2)) * pull)
    y.set((e.clientY - (r.top + r.height / 2)) * pull)
  }
  const leave = () => { x.set(0); y.set(0) }
  return (
    <motion.div className={cn('inline-flex', className)} style={{ x, y }} onPointerMove={move} onPointerLeave={leave}>
      {children}
    </motion.div>
  )
}
