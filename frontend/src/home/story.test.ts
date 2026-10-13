import { describe, expect, it } from 'vitest'
import { answerProgress, bump, galleryAt, gallerySnap, panelLook, revealed, sceneT, segment, tokenizeAnswer } from './story'

describe('tokenizeAnswer', () => {
  const cite = { text: 'a.py:1', filepath: 'a.py', line: 1, end_line: 1 }
  const { paragraphs, words, chipAfter } = tokenizeAnswer([
    [{ code: 'f' }, { text: ' calls g ' }, { cite }, { text: '. Done.' }],
    [{ text: 'Then ' }, { cite }],
  ])

  it('counts words and code spans, not spaces or citations', () => {
    // f, calls, g, ".", Done., Then
    expect(words).toBe(6)
  })

  it('places each citation after the word it follows', () => {
    expect(chipAfter).toEqual([2, 5])
  })

  it('keeps paragraphs and numbers words across them', () => {
    expect(paragraphs).toHaveLength(2)
    const numbered = paragraphs.flat().filter((t) => t.kind === 'word' || t.kind === 'code').map((t) => ('i' in t ? t.i : -1))
    expect(numbered).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('segment and revealed', () => {
  it('maps a window of progress onto 0..1', () => {
    expect(segment(0.5, 0.25, 0.75)).toBe(0.5)
    expect(segment(0.1, 0.25, 0.75)).toBe(0)
    expect(segment(0.9, 0.25, 0.75)).toBe(1)
  })

  it('counts how many items are showing', () => {
    expect(revealed(0, 10)).toBe(0)
    expect(revealed(0.55, 10)).toBe(5)
    expect(revealed(1, 10)).toBe(10)
  })
})

describe('answerProgress', () => {
  // 20 words; citations sit after words 4 and 15.
  const chips = [4, 15]

  it('shows nothing and checks nothing at the start', () => {
    expect(answerProgress(0, 20, chips)).toEqual({ words: 0, checked: [false, false] })
  })

  it('never checks a citation before it has been written', () => {
    for (let p = 0; p <= 1; p += 0.01) {
      const { words, checked } = answerProgress(p, 20, chips)
      chips.forEach((at, i) => {
        if (checked[i]) expect(words).toBeGreaterThan(at)
      })
    }
  })

  it('checks citations in order, and all of them by the end', () => {
    const mid = answerProgress(0.5, 20, chips)
    expect(mid.checked).toEqual([true, false])
    expect(answerProgress(1, 20, chips)).toEqual({ words: 20, checked: [true, true] })
  })
})

describe('gallery', () => {
  it('slides one panel per equal share of the scroll', () => {
    expect(galleryAt(0, 7)).toBe(0)
    expect(galleryAt(0.5, 7)).toBe(3)
    expect(galleryAt(1, 7)).toBe(6)
    expect(galleryAt(1.3, 7)).toBe(6)
  })

  it('rests on each panel', () => {
    expect(gallerySnap(5)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('plays a panel’s scene as it slides into the middle, finished once it’s there', () => {
    expect(sceneT(2, 3)).toBe(0) // still a whole panel away
    expect(sceneT(2.6, 3)).toBeCloseTo(0.5)
    expect(sceneT(3, 3)).toBe(1)
    expect(sceneT(4.5, 3)).toBe(1) // stays finished after it has passed
  })

  it('shrinks, dims and turns panels by how far they are from the middle', () => {
    expect(panelLook(0)).toEqual({ scale: 1, opacity: 1, rotate: 0 })
    const right = panelLook(1)
    expect(right.scale).toBeLessThan(1)
    expect(right.opacity).toBeLessThan(1)
    expect(right.rotate).toBeLessThan(0)
    expect(panelLook(-1).rotate).toBe(-right.rotate)
    expect(panelLook(3)).toEqual(panelLook(2))
  })
})

describe('bump', () => {
  it('rises from a to b and falls back by c', () => {
    expect(bump(0.1, 0.2, 0.4, 0.6)).toBe(0)
    expect(bump(0.3, 0.2, 0.4, 0.6)).toBeCloseTo(0.5)
    expect(bump(0.4, 0.2, 0.4, 0.6)).toBe(1)
    expect(bump(0.6, 0.2, 0.4, 0.6)).toBe(0)
  })
})
