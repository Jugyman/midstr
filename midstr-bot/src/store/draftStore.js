import crypto from 'crypto'

/**
 * In-memory draft store for first pass.
 * Replace with Redis / Supabase / DB later.
 */
class DraftStore {
  constructor() {
    this.drafts = new Map()
  }

  createDraft(data) {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()

    const draft = {
      id,
      createdAt,
      updatedAt: createdAt,
      status: 'draft',
      ...data
    }

    this.drafts.set(id, draft)
    return draft
  }

  getDraft(id) {
    return this.drafts.get(id) || null
  }

  updateDraft(id, patch) {
    const current = this.drafts.get(id)
    if (!current) return null

    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    }

    this.drafts.set(id, next)
    return next
  }

  deleteDraft(id) {
    return this.drafts.delete(id)
  }

  getAllDrafts() {
    return Array.from(this.drafts.values())
  }
}

export const draftStore = new DraftStore()