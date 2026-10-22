/** ADR 0020: purchases are observed for a creator-chosen number of whole days after delivery. */
export const defaultObservationDays = 7;
export const minObservationDays = 1;
export const maxObservationDays = 90;

const day = 86_400_000;

export function observationEndFor(scheduledAt: string, days: number): string {
  return new Date(Date.parse(scheduledAt) + days * day).toISOString();
}

/** Null when the end is a whole number of days, within bounds, after delivery; otherwise why not. */
export function observationWindowProblem(scheduledAt: string, observationEndsAt: string): string | null {
  const start = Date.parse(scheduledAt);
  const end = Date.parse(observationEndsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "The observation window needs a valid delivery and end time";
  const days = (end - start) / day;
  if (!Number.isInteger(days) || days < minObservationDays || days > maxObservationDays) {
    return `The observation window must be ${minObservationDays}–${maxObservationDays} whole days after delivery`;
  }
  return null;
}
