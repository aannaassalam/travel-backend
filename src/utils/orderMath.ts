/**
 * Line-level money maths.
 *
 * Revenue and cost must be computed the same way or margin is silently wrong —
 * `lineTotal` already spans nights × quantity, so cost has to as well.
 * §4.1 makes gross margin a headline metric, and §15 lists shipping metrics
 * whose definitions don't line up as a way to lose trust in the whole dashboard.
 */

/** Nights covered by an item; 1 for anything without a date range. */
export const itemUnits = (item: {
   startDate?: Date | string
   endDate?: Date | string
}): number => {
   if (!item.startDate || !item.endDate) return 1
   const nights = Math.round(
      (new Date(item.endDate).getTime() - new Date(item.startDate).getTime()) /
         86400000
   )
   return Math.max(nights, 1)
}

/**
 * Cost of one line. Prefers the snapshotted `lineCost` when present so a later
 * change to how nights are counted can never rewrite historical margin.
 */
export const lineCost = (item: {
   lineCost?: number
   unitCostPrice: number
   quantity: number
   startDate?: Date | string
   endDate?: Date | string
}): number => {
   if (typeof item.lineCost === 'number') return item.lineCost
   return item.unitCostPrice * item.quantity * itemUnits(item)
}

export const orderCost = (items: any[] = []) =>
   items.reduce((sum, i) => sum + lineCost(i), 0)
