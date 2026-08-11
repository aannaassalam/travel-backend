/**
 * Seeds the legal text the public site used to hardcode into `PolicyVersion`
 * documents, so the admin's content section becomes the source of truth.
 *
 *   npx ts-node --transpile-only src/scripts/seedPolicies.ts
 *
 * Additive and idempotent: it creates nothing that already exists at the same
 * kind+locale+label, and it deletes nothing — the model forbids that anyway,
 * because historical orders reference these versions (§10).
 *
 * Body format is the plain text an owner can actually type into a textarea:
 * a line starting with `## ` is a heading, blank lines separate paragraphs.
 * Deliberately not HTML — this text is rendered into a page the client does
 * not control, and accepting markup from the admin panel would be a stored-XSS
 * hole for the sake of italics.
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { buildMongoUri } from '../config/db.config'
import { PolicyVersion } from '../model/settingsModel'

dotenv.config()

const section = (heading: string, body: string) => `## ${heading}\n\n${body}`
const doc = (sections: [string, string][]) =>
   sections.map(([h, b]) => section(h, b)).join('\n\n')

const TERMS_FR = doc([
   ['1. Réservations définitives', "Toutes les réservations effectuées sur cette plateforme sont définitives. Aucun remboursement n'est accordé, quelle qu'en soit la raison, une fois le paiement encaissé. Cette condition vous est présentée sur la page de l'offre, dans le récapitulatif de prix et à l'étape de paiement, et son acceptation est enregistrée avec votre réservation."],
   ['2. Annulation sans remboursement', "Vous pouvez demander l'annulation d'une réservation en contactant notre service client. L'annulation libère les places ou les chambres concernées, mais n'ouvre droit à aucun remboursement, total ou partiel, ni à aucun avoir."],
   ['3. Réservations payées en espèces', "Une réservation en espèces est maintenue 48 heures. Si le paiement n'est pas effectué avant l'échéance indiquée, la réservation est annulée automatiquement et les places sont remises en vente. Aucune somme n'est due de part et d'autre dans ce cas."],
   ['4. Lorsque nous ne pouvons pas assurer la prestation', "Si un vol est annulé par la compagnie, si un hôtel n'honore pas une réservation confirmée, ou si nous ne pouvons pas fournir la prestation vendue, contactez-nous immédiatement. Ces situations sont traitées au cas par cas par la direction et ne relèvent pas de la politique de non-remboursement ci-dessus."],
   ['5. Prix et devises', "Les prix sont établis en dollars américains. L'affichage en francs congolais ou en euros est une conversion au taux fixé par nos soins, verrouillé au moment de la commande. Le montant réellement débité vous est indiqué dans la devise de règlement avant validation du paiement."],
   ['6. Documents de voyage et identité', "Vous êtes responsable de l'exactitude des noms et des numéros de pièces d'identité fournis. Un billet émis au mauvais nom ne peut généralement pas être corrigé sans frais de la compagnie, et ces frais restent à votre charge."],
   ['7. Données personnelles', "Les numéros de passeport et de pièce d'identité sont conservés sous forme chiffrée et supprimés automatiquement 90 jours après la fin du voyage. Voir notre politique de confidentialité pour le détail."],
])

const TERMS_EN = doc([
   ['1. Bookings are final', 'All bookings made on this platform are final. No refund is granted, for any reason, once payment has been collected. This condition is shown on the offer page, in the price summary and at the payment step, and your acceptance is recorded against your booking.'],
   ['2. Cancellation without refund', 'You may ask us to cancel a booking by contacting customer service. Cancelling releases the seats or rooms concerned, but gives no right to any refund, whole or partial, and no credit note.'],
   ['3. Bookings paid in cash', 'A cash booking is held for 48 hours. If payment is not made before the stated deadline, the booking is cancelled automatically and the stock returns to sale. Nothing is owed by either side in that case.'],
   ['4. When we cannot deliver', 'If an airline cancels a flight, a hotel does not honour a confirmed booking, or we cannot supply what was sold, contact us immediately. These situations are handled case by case by management and fall outside the no-refund policy above.'],
   ['5. Prices and currencies', 'Prices are set in US dollars. Display in Congolese francs or euros is a conversion at our own rate, locked at the moment you order. The amount actually charged is shown to you in the settlement currency before you confirm payment.'],
   ['6. Travel documents and identity', 'You are responsible for the accuracy of the names and document numbers you provide. A ticket issued in the wrong name usually cannot be corrected without an airline fee, and that fee remains yours to pay.'],
   ['7. Personal data', 'Passport and ID numbers are stored encrypted and deleted automatically 90 days after travel ends. See our privacy policy for detail.'],
])

const PRIVACY_FR = doc([
   ['Ce que nous collectons', "Votre numéro de téléphone (identifiant du compte), votre nom, votre adresse e-mail si vous en fournissez une, et les données nécessaires à la prestation réservée : noms des voyageurs, dates, et pour les vols le type et le numéro de la pièce d'identité. Nous enregistrons également l'acceptation horodatée de nos conditions."],
   ['Ce que nous ne collectons pas', "Nous ne voyons ni ne stockons vos numéros de carte bancaire : les paiements par carte se font sur la page sécurisée de notre prestataire. Nous ne collectons pas votre localisation en arrière-plan, ni vos contacts."],
   ['Combien de temps nous les gardons', "Les numéros de passeport et de pièce d'identité sont chiffrés et supprimés automatiquement 90 jours après la fin du voyage. Les données de réservation sont conservées le temps requis par les obligations comptables. Les journaux techniques sont conservés 90 jours."],
   ['Comment elles sont protégées', "Les données sensibles sont chiffrées au repos. Les documents de voyage sont stockés dans des espaces privés et servis par des liens signés à durée limitée, jamais par une adresse publique permanente. Les accès aux données sont journalisés."],
   ['Avec qui nous les partageons', "Uniquement avec les prestataires nécessaires à votre réservation : compagnie aérienne, hôtel, loueur, opérateur de bus, et notre prestataire de paiement. Nous ne vendons aucune donnée et n'utilisons pas de traceurs publicitaires tiers."],
   ['Vos droits', "Vous pouvez consulter et corriger vos données depuis votre compte, et supprimer votre compte à tout moment depuis la page Profil. Les réservations déjà payées restent enregistrées pour des raisons comptables et légales."],
   ['Nous contacter', "Écrivez à privacy@congotravel.cd ou passez à notre bureau de Gombe. Nous répondons sous 30 jours."],
])

const PRIVACY_EN = doc([
   ['What we collect', 'Your phone number (your account identifier), your name, your email address if you give one, and whatever the booked service needs: traveller names, dates, and for flights the type and number of the identity document. We also record the timestamped acceptance of our terms.'],
   ['What we do not collect', "We never see or store your card numbers: card payments happen on our provider's secure page. We do not collect background location, and we do not collect your contacts."],
   ['How long we keep it', 'Passport and ID numbers are encrypted and deleted automatically 90 days after travel ends. Booking data is kept for as long as accounting obligations require. Technical logs are kept for 90 days.'],
   ['How it is protected', 'Sensitive data is encrypted at rest. Travel documents live in private storage and are served through short-lived signed links, never a permanent public address. Access to data is logged.'],
   ['Who we share it with', 'Only the suppliers your booking requires: the airline, hotel, car hire company, bus operator, and our payment provider. We sell no data and use no third-party advertising trackers.'],
   ['Your rights', 'You can view and correct your data from your account, and delete your account at any time from the Profile page. Bookings already paid remain on record for accounting and legal reasons.'],
   ['Contacting us', 'Write to privacy@congotravel.cd or come to our Gombe office. We reply within 30 days.'],
])

/**
 * §2.2: the single sentence the customer ticks. It is the one policy that also
 * gets snapshotted onto an order, so it stays short and stands alone.
 */
const NO_REFUND_FR =
   "Je comprends que cette réservation est définitive et non remboursable. Aucun remboursement ni annulation avec remboursement ne sera accordé."
const NO_REFUND_EN =
   'I understand that this booking is final and non-refundable. No refund, and no cancellation with refund, will be granted.'

const SEED = [
   { kind: 'TERMS', locale: 'fr', label: 'v1.0', body: TERMS_FR },
   { kind: 'TERMS', locale: 'en', label: 'v1.0', body: TERMS_EN },
   { kind: 'PRIVACY', locale: 'fr', label: 'v1.0', body: PRIVACY_FR },
   { kind: 'PRIVACY', locale: 'en', label: 'v1.0', body: PRIVACY_EN },
   { kind: 'NO_REFUND', locale: 'fr', label: 'v1.0', body: NO_REFUND_FR },
   { kind: 'NO_REFUND', locale: 'en', label: 'v1.0', body: NO_REFUND_EN },
]

async function main() {
   // Same builder the server uses, so DATABASE_PASSWORD is applied identically.
   await mongoose.connect(buildMongoUri())
   // Never print the URI — it carries the Atlas password.
   console.log(`connected to ${mongoose.connection.name}\n`)

   for (const entry of SEED) {
      const existing = await PolicyVersion.findOne({
         kind: entry.kind,
         locale: entry.locale,
         label: entry.label,
      })
      if (existing) {
         // Text is immutable by design, so a re-run must not try to update it.
         if (!existing.isLive) {
            existing.isLive = true
            await existing.save()
            console.log(`  ${entry.kind}/${entry.locale}  existed -> set live`)
         } else {
            console.log(`  ${entry.kind}/${entry.locale}  already live, skipped`)
         }
         continue
      }

      // Exactly one live version per kind+locale, same rule setPolicyLive enforces.
      const siblings = await PolicyVersion.find({
         kind: entry.kind,
         locale: entry.locale,
         isLive: true,
      })
      for (const s of siblings) {
         s.isLive = false
         await s.save()
      }

      await PolicyVersion.create({ ...entry, isLive: true })
      console.log(`  ${entry.kind}/${entry.locale}  created, live (${entry.body.length} chars)`)
   }

   const live = await PolicyVersion.countDocuments({ isLive: true })
   console.log(`\n${live} live policy versions in ${mongoose.connection.name}`)
   await mongoose.disconnect()
}

main().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
