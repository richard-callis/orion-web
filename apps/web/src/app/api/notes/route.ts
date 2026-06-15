import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateNoteSchema } from '@/lib/validate'
import { embedNote, computeSemanticEdges } from '@/lib/embeddings'

export const { GET, POST } = makeCrudRoutes({
  model:        'note',
  createSchema: CreateNoteSchema,
  listFilters:  ['type'],
  orderBy:      [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  scopeByCreatedBy: true,
  // Stamp the creating user. Spread raw first so all note fields are preserved.
  // Service/gateway callers (caller === null) leave createdBy null → shared note.
  transformData: (raw, caller) => ({ ...raw, createdBy: caller?.id ?? null }),
  afterCreate:  async (record) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = record as any
    const ok = await embedNote(r).catch(err => { console.error('[embed] failed for new note:', err); return false })
    if (ok) computeSemanticEdges(r.id).catch(() => {})
  },
})
