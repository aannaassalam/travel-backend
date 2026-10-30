/**
 * The names a map point gets from MapTiler's reverse geocoder, checked on real
 * answers for Kinshasa (2026-10-30, language=fr). No test framework, as for
 * test:leak:
 *
 *   npm run test:geocoding
 */
import assert from 'assert'
import { shortName } from './geocoding.service'

const ctx = (...layers: [string, string][]) => layers.map(([layer, text]) => ({ id: `${layer}.1`, text }))
const COUNTRY: [string, string] = ['country', 'République démocratique du Congo']
const AFRICA: [string, string] = ['continental_marine', 'Afrique']

// A road: the areas around it say where, the country does not.
assert.strictEqual(
   shortName({
      id: 'road.1',
      text: 'Route nationale 1',
      place_name: 'Route nationale 1, République démocratique du Congo',
      context: ctx(['municipality', 'Mont Ngafula'], ['region', 'Kinshasa'], COUNTRY, AFRICA),
   }),
   'Route nationale 1, Mont Ngafula, Kinshasa'
)

// An address keeps its number; a landform (the river) is not a place to be driven to.
assert.strictEqual(
   shortName({
      id: 'address.1',
      text: 'Avenue Ngongo Lutete',
      place_name: 'Avenue Ngongo Lutete 77, Kinshasa, République démocratique du Congo',
      context: ctx(['major_landform', 'Pool Malebo'], ['region', 'Kinshasa'], COUNTRY, AFRICA),
   }),
   'Avenue Ngongo Lutete 77, Kinshasa'
)

// A repeated area (place and commune share a name) is said once, three parts at most.
assert.strictEqual(
   shortName({
      id: 'address.2',
      text: 'Avenue Radio',
      place_name: 'Avenue Radio, Lingwala, La Voix du Peuple, Lingwala, Kinshasa, République démocratique du Congo',
      context: ctx(
         ['place', 'Lingwala'],
         ['municipal_district', 'La Voix du Peuple'],
         ['municipality', 'Lingwala'],
         ['region', 'Kinshasa'],
         COUNTRY,
         AFRICA
      ),
   }),
   'Avenue Radio, Lingwala, La Voix du Peuple'
)

// Across the river: inside the DRC's rough box, so the country is said.
assert.strictEqual(
   shortName({
      id: 'address.3',
      text: 'Avenue des Trois Martyrs',
      place_name: 'Avenue des Trois Martyrs 99, Moungali (arrondissement 4), Brazzaville (commune), Congo-Brazzaville',
      properties: { country_code: 'cg' },
      context: ctx(
         ['major_landform', 'Mfilou'],
         ['joint_municipality', 'Moungali (arrondissement 4)'],
         ['county', 'Brazzaville (commune)'],
         ['country', 'Congo-Brazzaville'],
         AFRICA
      ),
   }),
   'Avenue des Trois Martyrs 99, Moungali (arrondissement 4), Congo-Brazzaville'
)

// Nothing but the country or the continent: no name, the coordinates stay.
assert.strictEqual(shortName({ id: 'country.1', text: 'République démocratique du Congo', context: ctx(AFRICA) }), null)
assert.strictEqual(shortName(undefined), null)

console.log('geocoding names: ok')
