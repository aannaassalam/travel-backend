/** A user's text as a literal inside a RegExp. */
export const escapeRx = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The whole name and nothing else, whatever its case or the spaces around it.
 * Hotels and restaurants type their city by hand, so "kinshasa" and
 * "Kinshasa " are the same place as the location called Kinshasa.
 */
export const sameName = (name: string) => new RegExp(`^\\s*${escapeRx(name.trim())}\\s*$`, 'i')
