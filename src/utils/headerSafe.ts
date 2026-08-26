import { NextFunction, Request, Response } from 'express'

/**
 * HTTP header values are Latin-1 (RFC 7230). Node enforces it: any character
 * outside that range makes `setHeader` throw ERR_INVALID_CHAR, which turns a
 * perfectly good response into a 500 with a stack trace.
 *
 * This is not theoretical here. The copy in this product is written with real
 * typography (em dashes, curly quotes, ellipses) and it is bilingual. One em
 * dash in a success message took down an entire endpoint. Accented Latin-1
 * characters such as e-acute and c-cedilla are inside the range and pass
 * through untouched, so French text still reads correctly; it is the
 * typographic punctuation that breaks.
 *
 * Rather than remember this at every call site forever, `guardHeaders` below
 * wraps `res.setHeader` once, so nothing anywhere can throw.
 */

const REPLACEMENTS: [RegExp, string][] = [
   // hyphens, en dash, em dash, horizontal bar
   [/[\u2010-\u2015]/g, '-'],
   // curly single quotes
   [/[\u2018\u2019\u201A\u201B]/g, "'"],
   // curly double quotes
   [/[\u201C\u201D\u201E\u201F]/g, '"'],
   [/\u2026/g, '...'],
   // non-breaking and narrow spaces
   [/[\u00A0\u2007\u202F\u2009]/g, ' '],
   [/[\u2022\u00B7]/g, '-'],
   // the euro sign sits outside Latin-1
   [/\u20AC/g, 'EUR'],
]

/** Makes any string safe to put in a header. Never throws. */
export const headerSafe = (value: string): string => {
   let out = String(value)
   for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement)
   return out
      // Control characters would allow header injection, not merely an error.
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      // Anything still outside Latin-1 is dropped rather than guessed at.
      .replace(/[^\u0020-\u00FF]/g, '')
      .trim()
}

/**
 * Wraps `res.setHeader` for every response.
 *
 * Everything that sets a header goes through it: `res.set`, `res.cookie`,
 * `res.type`, `res.attachment`, and Express's own internals. A stray character
 * in a filename, a mime type or a message can therefore never 500 a request.
 * Numbers and arrays are handled too, because Set-Cookie is an array.
 */
export const guardHeaders = (_req: Request, res: Response, next: NextFunction) => {
   const original = res.setHeader.bind(res)
   res.setHeader = function (name: string, value: number | string | readonly string[]) {
      if (typeof value === 'string') return original(name, headerSafe(value))
      if (Array.isArray(value)) return original(name, value.map((v) => headerSafe(String(v))))
      return original(name, value as number)
   } as typeof res.setHeader
   next()
}
