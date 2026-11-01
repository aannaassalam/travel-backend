import { AsyncLocalStorage } from 'async_hooks'
import { NextFunction, Request, Response } from 'express'
import { Localized, resolveLocalized, toLocalized } from '../model/shared.schema'

/**
 * Texts the office types in every language (opening hours, room beds, zone
 * names, office hours, an offer's meeting point…) went from one string to one
 * per language on 2026-10-31. App builds from before render them as text and
 * would crash on an object, so only a client that asks for the per-language
 * form — `?i18n=1`, sent by the website and today's app — gets it; any other
 * caller gets the French string, exactly as before. A query parameter rather
 * than a header: a custom header would cost every browser call a preflight.
 */
const wantsLocalized = new AsyncLocalStorage<boolean>()

export const clientContent = (req: Request, _res: Response, next: NextFunction) =>
   wantsLocalized.run(req.query.i18n === '1', next)

/** A per-language text for the public API: the object for clients that read it, French for older ones. */
export const textOut = (
   value: unknown,
   perLanguage: (v: unknown) => Localized = toLocalized
): Localized | string =>
   wantsLocalized.getStore() ? perLanguage(value) : resolveLocalized(value as any, 'fr')

/** For the self-checks: present as a client that asked for the per-language form, or as an older one. */
export const asClient = <T>(perLanguage: boolean, fn: () => T) => wantsLocalized.run(perLanguage, fn)
