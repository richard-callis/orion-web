import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateNoteSchema } from '@/lib/validate'
import { embedNote, computeSemanticEdges } from '@/lib/embeddings'

export const { GET, POST } = makeCrudRoutes({
  model:        'note',
  createSchema: CreateNoteSchema,
  listFilters:  ['type'],
  orderBy:      [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  afterCreate:  async (record) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await embedNote(record as any).catch(err => { console.error('[embed] failed for new note:', err); return false })
    if (ok) computeSemanticEdges(record.id).catch(() => {})
  },
})
