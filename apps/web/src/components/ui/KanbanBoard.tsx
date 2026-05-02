'use client'
import React from 'react'

export interface KanbanColumn<T> {
  key: string
  label: string
  topBorderClass: string
  items: T[]
  renderItem: (item: T) => React.ReactNode
  emptyText?: string
}

interface Props<T> {
  columns: KanbanColumn<T>[]
  columnWidth?: string
  columnBg?: string
}

export function KanbanBoard<T>({ columns, columnWidth = 'w-52', columnBg = 'bg-bg-sidebar' }: Props<T>) {
  return (
    <div className="flex gap-3 overflow-x-auto overflow-y-hidden flex-1">
      {columns.map(col => (
        <div
          key={col.key}
          className={`flex-shrink-0 ${columnWidth} flex flex-col rounded-lg border border-border-subtle border-t-2 ${col.topBorderClass} ${columnBg} overflow-hidden`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <span className="text-xs font-medium text-text-secondary">{col.label}</span>
            <span className="text-[10px] text-text-muted">{col.items.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {col.items.map((item, i) => (
              <React.Fragment key={i}>{col.renderItem(item)}</React.Fragment>
            ))}
            {col.items.length === 0 && (
              <p className="text-[10px] text-text-muted text-center py-4">
                {col.emptyText ?? 'No items'}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
