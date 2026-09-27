'use client'
import { useEffect, useId, useState } from 'react'
import { Settings } from 'lucide-react'

export type FreqType = 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FREQS: FreqType[] = ['minutely', 'hourly', 'daily', 'weekly', 'monthly']

export function buildCron(freq: FreqType, every: number, minute: number, hour: number, weekday: number, monthDay: number): string {
  switch (freq) {
    case 'minutely': return every <= 1 ? '* * * * *' : `*/${every} * * * *`
    case 'hourly':   return every <= 1 ? `${minute} * * * *` : `${minute} */${every} * * *`
    case 'daily':    return `${minute} ${hour} * * *`
    case 'weekly':   return `${minute} ${hour} * * ${weekday}`
    case 'monthly':  return `${minute} ${hour} ${monthDay} * *`
    default:         return ''
  }
}

export function describeCron(freq: FreqType, every: number, minute: number, hour: number, weekday: number, monthDay: number): string {
  const mm = String(minute).padStart(2, '0')
  const hhmm = `${String(hour).padStart(2, '0')}:${mm}`
  switch (freq) {
    case 'minutely': return every <= 1 ? 'Every minute' : `Every ${every} minutes`
    case 'hourly':   return every <= 1 ? `Every hour at :${mm}` : `Every ${every} hours at :${mm}`
    case 'daily':    return `Daily at ${hhmm}`
    case 'weekly':   return `Every ${DAYS[weekday]} at ${hhmm}`
    case 'monthly':  return `Monthly on day ${monthDay} at ${hhmm}`
    default:         return ''
  }
}

const sel = 'px-2 py-1.5 text-sm bg-bg-base border border-border-subtle rounded-sm text-text-primary focus:outline-hidden focus:border-accent'
const num = sel + ' w-16 text-center'

export function CronBuilder({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const id = useId()
  const [advanced, setAdvanced] = useState(false)
  const [freq, setFreq]         = useState<FreqType>('daily')
  const [every, setEvery]       = useState(1)
  const [minute, setMinute]     = useState(0)
  const [hour, setHour]         = useState(9)
  const [weekday, setWeekday]   = useState(1)
  const [monthDay, setMonthDay] = useState(1)

  const generatedCron = buildCron(freq, every, minute, hour, weekday, monthDay)
  const humanLabel    = describeCron(freq, every, minute, hour, weekday, monthDay)

  useEffect(() => {
    if (!advanced) onChange(generatedCron)
  }, [advanced, generatedCron]) // eslint-disable-line react-hooks/exhaustive-deps -- onChange is a fresh closure each render

  const numInput = (label: string, v: number, set: (n: number) => void, min: number, max: number) => (
    <input type="number" aria-label={label} min={min} max={max} value={v} onChange={e => set(+e.target.value)} className={num} />
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor={advanced ? `${id}-cron` : undefined} className="block text-xs text-text-secondary">Schedule</label>
        <button
          type="button"
          onClick={() => { setAdvanced(a => !a); if (!advanced) onChange(generatedCron) }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-accent transition-colors"
        >
          <Settings size={11} />
          {advanced ? 'Simple mode' : 'Advanced (cron)'}
        </button>
      </div>

      {advanced ? (
        <input
          id={`${id}-cron`}
          className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded-sm text-text-primary font-mono focus:outline-hidden focus:border-accent"
          placeholder="0 9 * * 1"
          value={value}
          onChange={e => onChange(e.target.value)}
          required
        />
      ) : (
        <div className="space-y-3 p-3 bg-bg-base border border-border-subtle rounded-lg">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Frequency">
            {FREQS.map(f => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={freq === f}
                onClick={() => setFreq(f)}
                className={`px-2.5 py-1 text-xs rounded-sm transition-colors ${freq === f ? 'bg-accent text-white' : 'bg-bg-raised text-text-secondary hover:text-text-primary'}`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            {freq === 'minutely' && (
              <>
                <span>Every</span>
                {numInput('Minutes', every, setEvery, 1, 59)}
                <span>minute{every !== 1 ? 's' : ''}</span>
              </>
            )}
            {freq === 'hourly' && (
              <>
                <span>Every</span>
                {numInput('Hours', every, setEvery, 1, 23)}
                <span>hour{every !== 1 ? 's' : ''} at minute</span>
                {numInput('Minute', minute, setMinute, 0, 59)}
              </>
            )}
            {(freq === 'daily' || freq === 'weekly' || freq === 'monthly') && (
              <>
                {freq === 'weekly' && (
                  <>
                    <span>Every</span>
                    <select aria-label="Weekday" value={weekday} onChange={e => setWeekday(+e.target.value)} className={sel}>
                      {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </>
                )}
                {freq === 'monthly' && (
                  <>
                    <span>On day</span>
                    {numInput('Day of month', monthDay, setMonthDay, 1, 28)}
                  </>
                )}
                <span>at</span>
                {numInput('Hour', hour, setHour, 0, 23)}
                <span>:</span>
                {numInput('Minute', minute, setMinute, 0, 59)}
              </>
            )}
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-text-primary font-medium">{humanLabel}</span>
            <span className="font-mono text-text-muted">{generatedCron}</span>
          </div>
        </div>
      )}
    </div>
  )
}
