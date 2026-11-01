import { NOTIFICATION_EVENTS } from '../model/enquiryModel'
import type { Localized } from '../model/shared.schema'

/**
 * The SMS wording each event starts with, for two readers: the seed, which
 * writes them all on a fresh database, and every boot (ensureDefaultTemplates),
 * which adds only the ones a database has no SMS template for — so an event
 * added in a release is never silent, and the office's own wording is never
 * overwritten.
 *
 * Every order template carries {{order_link}}. That link is how a GUEST reaches
 * their booking - they have no account, so without it a cash customer has
 * nothing but a reference read out over the phone.
 *
 * Per language (2026-10-31): French for every event, the office's language and
 * the one required; English kept where the default was English. A customer in
 * another language gets English, then French, until the office types theirs.
 */
export const NOTIFICATION_TEMPLATE_DEFAULTS: { event: string; body: Localized }[] = [
   {
      event: NOTIFICATION_EVENTS.ORDER_CONFIRMED,
      body: {
         fr: 'Bonjour {{customer_name}}, votre réservation {{order_ref}} ({{amount}}) est enregistrée. Suivez-la ici : {{order_link}}',
         en: 'Hello {{customer_name}}, your booking {{order_ref}} ({{amount}}) is registered. Track it here: {{order_link}}',
      },
   },
   {
      event: NOTIFICATION_EVENTS.PAYMENT_RECEIVED,
      body: {
         fr: 'Paiement reçu pour {{order_ref}}. Merci {{customer_name}}. Détails : {{order_link}}',
         en: 'Payment received for {{order_ref}}. Thank you {{customer_name}}. Details: {{order_link}}',
      },
   },
   {
      event: NOTIFICATION_EVENTS.CASH_DEADLINE_REMINDER,
      body: {
         fr: 'Rappel : le paiement en espèces de {{order_ref}} ({{amount}}) est attendu avant le {{deadline}}. {{order_link}}',
         en: 'Reminder: cash payment for {{order_ref}} ({{amount}}) is due by {{deadline}}. {{order_link}}',
      },
   },
   {
      event: NOTIFICATION_EVENTS.DOCUMENTS_ISSUED,
      body: {
         fr: 'Vos documents pour {{order_ref}} sont prêts : {{order_link}}',
         en: 'Your documents for {{order_ref}} are ready: {{order_link}}',
      },
   },
   {
      event: NOTIFICATION_EVENTS.ORDER_CANCELLED,
      body: {
         fr: 'Votre réservation {{order_ref}} a été annulée. Détails : {{order_link}}',
         en: 'Your booking {{order_ref}} has been cancelled. Details: {{order_link}}',
      },
   },
   {
      event: NOTIFICATION_EVENTS.ORDER_COMPLETED,
      body: {
         fr: "Votre réservation {{order_ref}} est terminée. Merci d'avoir choisi Flexi Agency ! {{order_link}}",
         en: 'Your booking {{order_ref}} is complete. Thank you for choosing Flexi Agency! {{order_link}}',
      },
   },
   {
      event: NOTIFICATION_EVENTS.ENQUIRY_RECEIVED,
      body: {
         fr: 'Merci {{customer_name}}, votre demande {{order_ref}} est bien reçue. Nous vous appelons très vite.',
         en: 'Thank you {{customer_name}}, enquiry {{order_ref}} received. We will call you shortly.',
      },
   },
   {
      event: NOTIFICATION_EVENTS.QUOTE_SENT,
      body: {
         fr: 'Votre devis pour {{order_ref}} est prêt : {{amount}}. Nous revenons vers vous.',
         en: 'Your quote for {{order_ref}} is ready: {{amount}}. We will be in touch.',
      },
   },
   // Transfers (French: the office translates if it wants).
   {
      // Instead of ORDER_CONFIRMED's "pay at the office": a ride's cash goes to the driver.
      event: NOTIFICATION_EVENTS.TRANSFER_BOOKED,
      body: { fr: 'Course {{order_ref}} enregistrée pour {{departure_date}} : {{pickup}} → {{dropoff}}. {{amount}} à payer au chauffeur en espèces. Suivez votre course : {{order_link}}' },
   },
   {
      event: NOTIFICATION_EVENTS.TRANSFER_ASSIGNED,
      body: { fr: 'Votre chauffeur pour la course {{order_ref}} : {{driver_name}} ({{driver_phone}}), {{vehicle}}. Départ {{departure_date}} de {{pickup}}. {{order_link}}' },
   },
   {
      event: NOTIFICATION_EVENTS.TRANSFER_STARTED,
      body: { fr: 'Votre course {{order_ref}} a démarré avec {{driver_name}}.' },
   },
   {
      event: NOTIFICATION_EVENTS.TRANSFER_COMPLETED,
      body: { fr: 'Course {{order_ref}} terminée. Merci ! Notez votre chauffeur : {{order_link}}' },
   },
   {
      event: NOTIFICATION_EVENTS.DRIVER_RIDE_ASSIGNED,
      body: { fr: 'Nouvelle course {{order_ref}} : {{departure_date}}, {{pickup}} → {{dropoff}}, {{customer_name}} {{customer_phone}}. Détails : {{ride_link}}' },
   },
   {
      // Cancelled, unassigned or given to another driver: nobody drives out for nothing.
      event: NOTIFICATION_EVENTS.DRIVER_RIDE_REMOVED,
      body: { fr: 'La course {{order_ref}} du {{departure_date}} ({{pickup}}) ne vous est plus attribuée. Ne vous déplacez pas. {{ride_link}}' },
   },
   {
      // The portal link only: the password is given by the office, never texted.
      event: NOTIFICATION_EVENTS.DRIVER_WELCOME,
      body: { fr: 'Bienvenue chez Flexi Agency. Vos courses : {{ride_link}}' },
   },
   {
      // Sent even without this template (rideLifecycle has the same text built in).
      event: NOTIFICATION_EVENTS.TRANSFER_ALERT,
      body: { fr: 'ALERTE SÉCURITÉ course {{order_ref}} par {{alert_by}}. Chauffeur {{driver_name}} {{driver_phone}}, client {{customer_name}} {{customer_phone}}. Position : {{alert_location}}. {{ride_link}}' },
   },
]
