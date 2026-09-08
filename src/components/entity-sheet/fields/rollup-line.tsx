'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronRight, Sigma } from 'lucide-react'
import type { EntityRollupEntry, RollupBucket } from 'io2p-client'

import { cn } from '@/lib/utils'

/**
 * Whether an entry says anything worth a line.
 *
 * The node returns ONE ENTRY PER RULE ALWAYS — every rule visible to you, on
 * every object, whether or not it relates to this one. So an object with four
 * system rules and one relevant property renders three empty blocks unless they
 * are filtered here.
 *
 * Kept when it has a number, hit the subtree cap, or counted values it could not
 * parse — that last one is the reason `skippedCount` is not merely cosmetic:
 * "7 values could not be read" is the signal that a unit is wrong somewhere
 * below.
 *
 * A NEVER-COMPUTED entry (`computedAt: null`) is still not kept, but no longer because the number
 * is not coming — a rule change now arms every holder of its key, so one is on its way. It is not
 * kept because there is nothing to show YET, and an "Updating…" block that resolves to an empty
 * result would appear only to vanish. The poll refetches while any entry is stale, so the card
 * arrives on its own.
 */
export function rollupSaysSomething(entry: EntityRollupEntry): boolean {
  return (
    entry.buckets.length > 0 ||
    entry.error !== undefined ||
    entry.skippedCount > 0
  )
}

type NumericValues = readonly { num?: number; unit?: string }[]

/**
 * The factor the node applied to THIS object's contribution, mirroring how it resolves a
 * multiplier per row. `undefined` values mean the rule does not multiply at all.
 *
 * `null` means the node SKIPPED this object: a multiplier that is present but unreadable is
 * refused, never defaulted to one, because summing a contributor unscaled is the silent wrongness
 * the multiplier exists to prevent. Only an ABSENT multiplier falls back to one — "no quantity"
 * and "quantity 1" say the same thing.
 */
export function ownFactor(values: NumericValues | undefined): number | null {
  if (values === undefined) return 1 // the rule names no multiplier
  if (values.length === 0) return 1 // absent -> one
  if (values.length > 1) return null // several live values -> ambiguous
  const [only] = values
  if (only?.num === undefined) return null // present but never parsed
  return only.num < 0 ? null : only.num
}

/**
 * How the object's OWN value sits inside the lead bucket's total.
 *
 * `own` is in the bucket's canonical unit, not the authored one — a property
 * showing "0.8 t" beside a total of "800 kg" is one quantity printed two ways,
 * and the eye reads two facts. `DraftValue.num`/`unit` are already canonical
 * (the normalizer converts "2 t" to 2000 kg), which is the same basis the node
 * sums in, so no request and no conversion table is needed here.
 *
 * `below` is what the DESCENDANTS add — the number a reader is actually after
 * and currently has to do in their head, in the wrong units. Returned only when
 * every contributing unit matches the bucket's; a mixed-unit property cannot be
 * subtracted safely and gets no split.
 *
 * When the rule multiplies, the own values are SCALED first. Subtracting an unscaled own value
 * from a scaled total reported a difference that was not there: an object holding 100 kg at a
 * quantity of 3 contributes 300, and calling it 100 put the other 200 "below" an object that may
 * have nothing below it.
 */
export function ownShare(
  bucket: RollupBucket,
  ownValues: NumericValues,
  /** The object's live values under the key the rule multiplies by; omit when it names none. */
  multiplierValues?: NumericValues
): { own: number; below: number; onlyContributor: boolean } | null {
  const contributing = ownValues.filter(
    (v) => v.num !== undefined && v.unit === bucket.unit
  )
  if (contributing.length === 0) return null

  const factor = ownFactor(multiplierValues)
  if (factor === null) {
    // The node dropped this object's values, so none of the total is its own and it is not in
    // `contributorCount` either — everything shown belongs to the subtree below.
    return { own: 0, below: bucket.num, onlyContributor: false }
  }

  const own = contributing.reduce((sum, v) => sum + (v.num ?? 0), 0) * factor
  const below = bucket.num - own

  return {
    own,
    below,
    // Not `below === 0`: a descendant holding exactly zero is still a
    // contributor, and the count is what the node actually reports.
    //
    // A scaled contribution is never "the same number twice": the property row reads 12 kg and
    // the total reads 60 kg, so suppressing the total would hide the figure the rule was created
    // to produce. `factor === 1` is exact and needs no float comparison.
    onlyContributor:
      factor === 1 && bucket.contributorCount === contributing.length,
  }
}

/**
 * The subtree total for one property key: this object plus every descendant, summed by the node.
 *
 * A rollup is NOT a property and never becomes one — no value is written and no event is emitted,
 * so there is nothing to edit and no edit affordance to omit. It renders inside the property card
 * only because that is where the number it relates to already is.
 *
 * The total INCLUDES the object's own value, so the two overlap. Nothing here may read as
 * "children", and the two numbers must never invite addition.
 */
export function RollupLine({
  entry,
  ownUnit,
  ownValues,
  multiplierValues,
  compact = false,
  className,
}: {
  entry: EntityRollupEntry
  /**
   * The canonical unit of the object's own value under this key, when it has one. A hidden bucket
   * measuring something ELSE usually means a mis-keyed value, so that case opens by itself.
   * Compared against `bucket.unit` — `bucket.dimension` is a different vocabulary and would never
   * match.
   */
  ownUnit?: string
  /**
   * The object's own live values under this key, for the own/below split. Their
   * canonical `num`/`unit` are what make the comparison honest — omit them and
   * the line falls back to the bare total.
   */
  ownValues?: NumericValues
  /**
   * The object's own live values under `entry.multipliedBy`. Absent when the rule names no
   * multiplier — which is NOT the same as an empty array, since that means the key is named and
   * this object simply has no value for it.
   */
  multiplierValues?: NumericValues
  /**
   * Grid mode: one line, no expander. The compact card has nowhere to put a disclosure, so extra
   * dimensions are COUNTED there and read in the detailed view.
   */
  compact?: boolean
  className?: string
}) {
  const t = useTranslations()
  const buckets = [...entry.buckets].sort((a, b) => b.num - a.num)
  const [lead, ...rest] = buckets
  const foreign = rest.some((b) => b.unit !== ownUnit)
  const [open, setOpen] = useState(!compact && foreign)

  const share = lead ? ownShare(lead, ownValues ?? [], multiplierValues) : null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground',
        className
      )}
      data-testid="rollup-line"
    >
      <span className="flex shrink-0 items-center gap-1">
        <Sigma className="h-3 w-3" />
        {t('objects.properties.rollupTotal')}
      </span>

      {entry.error ? (
        <span className="text-destructive">
          {t('objects.properties.rollupSubtreeTooLarge')}
        </span>
      ) : lead === undefined ? (
        // Empty buckets mean one of two different things, and `computedAt`
        // is what separates them: `null` is "the worker has not run yet"
        // (synthesized entry, always `stale: true` — so the processing line
        // below is the whole message). A timestamp means it DID run and found
        // no numeric value under this key, which is a permanent answer, not a
        // pending one.
        entry.computedAt === null ? null : (
          <span>{t('objects.properties.rollupNoNumbers')}</span>
        )
      ) : (
        <>
          <BucketAmount bucket={lead} share={share} />
          {rest.length > 0 &&
            (compact ? (
              <span>
                {t('objects.properties.rollupMoreDimensions', {
                  count: rest.length,
                })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="flex items-center gap-0.5 underline-offset-2 hover:underline"
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 transition-transform',
                    open && 'rotate-90'
                  )}
                />
                {t('objects.properties.rollupMoreDimensions', {
                  count: rest.length,
                })}
              </button>
            ))}
        </>
      )}

      {entry.stale && !entry.error && (
        <span data-testid="rollup-stale">
          {t('objects.properties.rollupProcessing')}
        </span>
      )}
      {entry.skippedCount > 0 && (
        <span data-testid="rollup-skipped">
          {t('objects.properties.rollupSkipped', { count: entry.skippedCount })}
        </span>
      )}

      {open && rest.length > 0 && (
        <ul className="w-full space-y-0.5 pt-0.5">
          {rest.map((bucket) => (
            <li key={bucket.dimension} className="flex items-center gap-2">
              <BucketAmount bucket={bucket} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One dimension's sum. `unit` is absent on the `unitless` bucket, which is why it is appended
 * conditionally rather than interpolated — the same shape `ValueNormalization` uses.
 */
function BucketAmount({
  bucket,
  share,
}: {
  bucket: RollupBucket
  share?: ReturnType<typeof ownShare>
}) {
  const t = useTranslations()
  const format = useFormatter()
  const unit = bucket.unit ? ` ${bucket.unit}` : ''
  const amount = `${format.number(bucket.num)}${unit}`

  // The object IS the total. Saying it twice — once as the property's own value,
  // once as a "total" — invites the reader to look for a second number that does
  // not exist, so the line says so outright instead of restating the figure.
  if (share?.onlyContributor) {
    return (
      <span data-testid="rollup-only-self">
        {t('objects.properties.rollupOnlyThisObject')}
      </span>
    )
  }

  const ownPct =
    share && bucket.num > 0
      ? Math.min(100, Math.max(0, (share.own / bucket.num) * 100))
      : null

  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="font-medium text-foreground">{amount}</span>
      {ownPct !== null && share ? (
        <>
          {/* Two segments, not a percentage: the question is "how much of this
              is mine and how much is below me", and a bar answers it without
              the reader subtracting two numbers in their head. */}
          <span
            className="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={t('objects.properties.rollupSplitLabel', {
              own: `${format.number(share.own)}${unit}`,
              below: `${format.number(share.below)}${unit}`,
            })}
            data-testid="rollup-split-bar"
          >
            <span
              className="bg-foreground/60"
              style={{ width: `${ownPct}%` }}
            />
          </span>
          <span>
            {t('objects.properties.rollupBelowShare', {
              below: `${format.number(share.below)}${unit}`,
            })}
          </span>
        </>
      ) : (
        <span>
          {t('objects.properties.rollupContributors', {
            count: bucket.contributorCount,
          })}
        </span>
      )}
    </span>
  )
}
