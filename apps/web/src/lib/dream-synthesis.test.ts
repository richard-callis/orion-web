import { describe, it, expect } from 'vitest'
import { linkedTitles, mergeHub, parseHubs, renderHub, synthesisBatches, synthesisPrompt, SYNTHESIS_MAX_HUBS, type SynthesisNote } from './dream-synthesis'

const note = (title: string, folder = 'GitOps', tags: unknown = ['dream']): SynthesisNote => ({ title, folder, tags })
const many = (n: number, folder: string) => Array.from({ length: n }, (_, i) => note(`${folder} ${i}`, folder))

describe('synthesisBatches', () => {
  it('splits big folders, shares batches between small ones, loses nothing and leaves hubs out', () => {
    const notes = [...many(253, 'A'), ...many(80, 'B'), ...many(30, 'C'), ...many(3, 'D'), note('hub', 'A', ['dream', 'hub'])]
    const batches = synthesisBatches(notes, new Set(), 120)
    expect(batches.every(b => b.length <= 120)).toBe(true)
    expect(batches.flat().map(n => n.title).sort()).toEqual(notes.filter(n => n.title !== 'hub').map(n => n.title).sort())
    expect(batches.find(b => b.some(n => n.folder === 'D'))!.length).toBeGreaterThan(3)
  })
  it('leaves out notes a hub already links', () => {
    const notes = many(4, 'A')
    const linked = linkedTitles(notes.map(n => n.title), ['## Notes\n- [[A 0]]\n- [[A 1|alias]]', 'no links'])
    expect(synthesisBatches(notes, linked).flat().map(n => n.title)).toEqual(['A 2', 'A 3'])
  })
  it('counts every link mergeHub writes, whatever is in the title', () => {
    const titles = ['Fix [WIP]', 'if [[ -n x ]] check', 'arr[0] thing', 'plain']
    const content = renderHub({ title: 'H', overview: 'o', notes: titles, folder: 'GitOps' })
    expect([...linkedTitles([...titles, 'other'], [content])]).toEqual(titles)
    expect(mergeHub(content, { title: 'H', overview: 'o', notes: titles, folder: 'GitOps' })).toBeNull()
  })
  it('does not take a link to "C# tips" for a link to "C"', () => {
    expect([...linkedTitles(['C', 'C# tips', 'D'], ['- [[C# tips]]\n- [[D#part]]'])]).toEqual(['C# tips', 'D'])
  })
  it('never drops a lone leftover', () => {
    const notes = [...many(121, 'A'), ...many(120, 'B')]
    expect(synthesisBatches(notes, new Set(), 120).flat()).toHaveLength(241)
    expect(synthesisBatches([...many(1, 'A'), ...many(120, 'B')], new Set(), 120).flat()).toHaveLength(121)
  })
  it('has nothing to do for a single note', () => {
    expect(synthesisBatches([note('x')])).toEqual([])
    expect(synthesisBatches([])).toEqual([])
  })
})

describe('synthesisPrompt', () => {
  it('lists the batch and the hubs that may be extended', () => {
    const p = synthesisPrompt([note('Note A'), note('Note B')], ['Old Hub'])
    expect(p).toContain('Folder: GitOps\n- Note A\n- Note B')
    expect(p).toContain('EXISTING HUB NOTES:\n- Old Hub')
    expect(p).toContain('use its exact title')
  })
})

describe('parseHubs', () => {
  const batch = [note('A'), note('B'), note('C')]
  const hub = (over = {}) => ({ title: 'H', overview: 'o', notes: ['A', 'B'], folder: 'GitOps', ...over })

  it('reads the object form, a bare array, and JSON inside a code fence', () => {
    const want = [{ title: 'H', overview: 'o', notes: ['A', 'B'], folder: 'GitOps' }]
    expect(parseHubs(JSON.stringify({ hubs: [hub()] }), batch)).toEqual(want)
    expect(parseHubs(JSON.stringify([hub()]), batch)).toEqual(want)
    expect(parseHubs('```json\n' + JSON.stringify({ hubs: [hub()] }) + '\n```', batch)).toEqual(want)
  })
  it('drops titles that are not in the batch, and hubs left with fewer than two', () => {
    expect(parseHubs(JSON.stringify({ hubs: [hub({ notes: ['A', 'invented', 'C', 'A'] }), hub({ title: 'X', notes: ['A', 'invented'] })] }), batch))
      .toEqual([{ title: 'H', overview: 'o', notes: ['A', 'C'], folder: 'GitOps' }])
  })
  it('reads titles copied with a list dash or as wikilinks, and keeps ones that really look like that', () => {
    const odd = [...batch, note('[WIP] D'), note('- dashed')]
    expect(parseHubs(JSON.stringify({ hubs: [hub({ notes: ['- A', '[[B]]', '- [[C]]', '[WIP] D', '- dashed'] })] }), odd)[0].notes)
      .toEqual(['A', 'B', 'C', '[WIP] D', '- dashed'])
  })
  it('never links a hub to itself, and falls back to a known folder', () => {
    expect(parseHubs(JSON.stringify({ hubs: [hub({ title: 'C', notes: ['A', 'B', 'C'], folder: 'Nope' })] }), batch))
      .toEqual([{ title: 'C', overview: 'o', notes: ['A', 'B'], folder: 'Infrastructure' }])
  })
  it('skips malformed entries and caps the number', () => {
    const list = [null, {}, hub({ notes: 'A' }), ...Array.from({ length: 9 }, (_, i) => hub({ title: `H${i}` }))]
    expect(parseHubs(JSON.stringify({ hubs: list }), batch)).toHaveLength(SYNTHESIS_MAX_HUBS)
  })
  it('reads past reasoning that only has a closing tag, and titles that contain the tags', () => {
    const j = JSON.stringify({ hubs: [hub()] })
    expect(parseHubs(`maybe {"hubs":[]} hmm</think>${j}`, batch)).toHaveLength(1)
    const tagged = [note('Strip <think>x</think> tags'), note('B'), note('Ends with </think>')]
    const r = JSON.stringify({ hubs: [hub({ notes: tagged.map(n => n.title) })] })
    expect(parseHubs(r, tagged)[0].notes).toEqual(tagged.map(n => n.title))
    expect(parseHubs(`<think>[x] {"hubs": 1}</think>\n${r}`, tagged)[0].notes).toEqual(tagged.map(n => n.title))
  })
  it('lets an existing hub gain a single note, but not a new one start with it', () => {
    const one = JSON.stringify({ hubs: [hub({ title: 'Old', notes: ['A'] }), hub({ title: 'New', notes: ['B'] })] })
    expect(parseHubs(one, batch, ['Old'])).toEqual([{ title: 'Old', overview: 'o', notes: ['A'], folder: 'GitOps' }])
  })
  it('finds the list among other brackets', () => {
    const j = JSON.stringify({ hubs: [hub({ overview: 'a ] } [ { " quote' })] })
    for (const reply of [`Hubs for [GitOps]:\n${j}`, `<think>[GitOps] {"hubs": [1]}</think>${j}`, `${j}\nNote: see [1]`]) {
      expect(parseHubs(reply, batch)).toHaveLength(1)
    }
  })
  it('accepts no hubs, and throws on anything without a hub list', () => {
    expect(parseHubs('{"hubs": []}', batch)).toEqual([])
    expect(parseHubs('[]', batch)).toEqual([])
    for (const bad of ['sorry', '{"hubs": [{"title": "cut', '{"other": 1}', 'No hubs are missing [see 1].']) {
      expect(() => parseHubs(bad, batch), bad).toThrow('no hub list')
    }
  })
})

describe('renderHub and mergeHub', () => {
  const h = { title: 'H', overview: 'About.', notes: ['A', 'B'], folder: 'GitOps' }
  it('renders an overview and wikilinks', () => {
    expect(renderHub(h)).toBe('## Overview\nAbout.\n\n## Notes in this cluster\n- [[A]]\n- [[B]]')
  })
  it('adds only missing links and keeps everything already there', () => {
    const existing = '## Overview\nOld text.\n\n## Notes in this cluster\n- [[A]]\n- [[Z]]\n'
    expect(mergeHub(existing, h)).toBe('## Overview\nOld text.\n\n## Notes in this cluster\n- [[A]]\n- [[Z]]\n- [[B]]')
    expect(mergeHub(renderHub(h), h)).toBeNull()
  })
})
