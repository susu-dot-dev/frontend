/** Formats a Unix-seconds timestamp as a local date and time. */
export function formatTimestamp(seconds: number, locale?: string): string {
  return new Date(seconds * 1000).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** An id shortened for display, since a full UUID is noise in a table. */
export const shortId = (id: string) => id.slice(0, 8);
