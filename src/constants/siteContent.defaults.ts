/**
 * What the website says before anyone has edited it.
 *
 * This is the copy the site shipped with, moved here from the website's own
 * source so the panel's editor opens on the words that are live today rather
 * than on empty boxes. Once a section is saved from the panel, the saved text
 * is what the site shows; anything a later release adds here fills in until it
 * is edited too.
 *
 * French and English, because those are the two languages the site offers.
 * An empty image means the picture built into the website.
 */
export const SITE_CONTENT_DEFAULTS = {
   home: {
      heroImage: '',
      heroTitle: {
         fr: 'Réservez votre prochain voyage en RDC',
         en: 'Book your next trip in the DRC',
      },
      heroSubtitle: {
         fr: 'Vols, hôtels, bus, voitures et activités — stock vérifié, prix en USD, CDF ou EUR, paiement en espèces à notre agence.',
         en: 'Flights, hotels, buses, cars and activities — verified stock, prices in USD, CDF or EUR, pay in cash at our office.',
      },
   },

   about: {
      image: '',
      title: {
         fr: 'Une agence congolaise, avec du stock bien réel',
         en: 'A Congolese agency, with genuinely real stock',
      },
      intro: {
         fr: 'Flexi Agency réserve des vols, des hôtels, des bus, des voitures et des excursions en République démocratique du Congo, et met en relation acheteurs et vendeurs de biens immobiliers.',
         en: 'Flexi Agency books flights, hotels, buses, cars and tours across the Democratic Republic of the Congo, and connects buyers and sellers of property.',
      },
      sections: [
         {
            title: { fr: 'Nous achetons avant de vendre', en: 'We buy before we sell' },
            body: {
               fr: "Nous ne sommes pas un moteur de recherche branché sur un système de réservation mondial. Nous achetons des places, des chambres, des journées de véhicule et des créneaux d'excursion à l'avance, et nous les revendons. C'est notre argent qui est engagé, ce qui nous oblige à n'afficher que du stock réel.",
               en: 'We are not a search engine plugged into a global reservation system. We buy seats, rooms, vehicle-days and tour slots in advance, and resell them. It is our own money at risk, which forces us to list only real stock.',
            },
         },
         {
            title: { fr: 'Payer comme on paie ici', en: 'Paying the way people pay here' },
            body: {
               fr: 'Vous réservez en ligne et vous réglez en espèces à notre agence, avec la référence reçue par SMS. La réservation est maintenue 48 heures, le temps de passer nous voir.',
               en: 'You book online and pay in cash at our office, with the reference sent by SMS. The booking is held for 48 hours, time enough to come and see us.',
            },
         },
         {
            title: { fr: 'Une équipe joignable', en: 'A team you can reach' },
            body: {
               fr: "Un bureau physique à Gombe, un numéro qui répond, un WhatsApp lu. Dans un marché où la réputation circule par les réseaux personnels, c'est ce qui compte le plus.",
               en: 'A physical office in Gombe, a number that answers, a WhatsApp that gets read. In a market where reputation travels through personal networks, that matters most.',
            },
         },
         {
            title: { fr: 'La RDC, pas le monde entier', en: 'The DRC, not the whole world' },
            body: {
               fr: 'Nous couvrons Kinshasa, le Katanga, les Kivus, le Kasaï et le Kongo-Central. Nous préférons bien connaître huit villes plutôt que mal en connaître deux cents.',
               en: 'We cover Kinshasa, Katanga, the Kivus, Kasaï and Kongo-Central. We would rather know eight cities well than two hundred badly.',
            },
         },
      ],
      listTitle: { fr: 'Ce que nous ne faisons pas', en: 'What we do not do' },
      listItems: [
         {
            fr: 'Nous ne remboursons pas. Toutes les réservations sont définitives, et nous vous le disons avant que vous payiez, pas après.',
            en: 'We do not refund. All bookings are final, and we tell you before you pay, not after.',
         },
         {
            fr: "Nous n'affichons pas de faux compteurs d'urgence. Quand il reste trois places, c'est qu'il en reste trois.",
            en: 'We do not run fake urgency counters. When three seats are left, three seats are left.',
         },
         {
            fr: 'Nous ne révélons aucun frais à la dernière étape. Le prix affiché est le prix payé.',
            en: 'We do not reveal a fee at the last step. The price shown is the price paid.',
         },
         {
            fr: "Nous ne vendons pas vos données et n'utilisons pas de traceurs publicitaires.",
            en: 'We do not sell your data and use no advertising trackers.',
         },
      ],
   },

   contact: {
      intro: {
         fr: 'Une vraie personne répond, au bureau comme au téléphone. Vous pouvez aussi venir régler votre réservation en espèces.',
         en: 'A real person answers, in the office and on the phone. You can also come and settle a booking in cash.',
      },
      formTitle: { fr: 'Écrivez-nous', en: 'Write to us' },
      formIntro: {
         fr: 'Nous rappelons sous 24 heures ouvrées au numéro que vous laissez.',
         en: 'We call back within 24 working hours on the number you leave.',
      },
   },

   help: {
      intro: {
         fr: "Les questions qu'on nous pose le plus souvent, avec des réponses directes.",
         en: 'The questions we get asked most, answered directly.',
      },
      faq: [
         {
            question: { fr: 'Puis-je annuler et être remboursé ?', en: 'Can I cancel and get a refund?' },
            answer: {
               fr: "Non. Toutes nos réservations sont définitives et non remboursables. Vous pouvez demander l'annulation d'une réservation en nous contactant, ce qui libère la place ou la chambre, mais aucune somme n'est restituée. Cette condition vous est présentée trois fois avant le paiement et votre acceptation est enregistrée.",
               en: 'No. All our bookings are final and non-refundable. You can ask us to cancel a booking, which releases the seat or room, but no money is returned. This condition is shown to you three times before payment and your acceptance is recorded.',
            },
         },
         {
            question: { fr: 'Comment puis-je payer ?', en: 'How can I pay?' },
            answer: {
               fr: 'En espèces, à notre bureau de Gombe, avec la référence reçue par SMS. Votre réservation est maintenue 48 heures ; passé ce délai elle est annulée automatiquement et les places sont remises en vente.',
               en: 'In cash, at our Gombe office, with the reference sent by SMS. Your booking is held for 48 hours; after that it is cancelled automatically and the stock returns to sale.',
            },
         },
         {
            question: {
               fr: 'Ma recherche ne donne aucun résultat. Pourquoi ?',
               en: 'My search returns nothing. Why?',
            },
            answer: {
               fr: "Nous achetons nos places et nos chambres à l'avance : notre stock est réel mais limité. Si rien ne correspond, remplissez le formulaire de demande. Nous cherchons pour vous et revenons avec un prix ferme, sans engagement de votre part.",
               en: 'We buy our seats and rooms in advance: our stock is real but limited. If nothing matches, fill in the request form. We source it and come back with a firm price, with no commitment from you.',
            },
         },
         {
            question: {
               fr: 'Dans quelle devise vais-je être débité ?',
               en: 'Which currency will I be charged in?',
            },
            answer: {
               fr: 'Les prix sont établis en francs congolais. Si vous affichez le site en dollars américains ou en euros, le montant exact qui sera débité vous est indiqué avant validation, dans la devise de règlement. Le taux est verrouillé au moment de la commande.',
               en: 'Prices are set in Congolese francs. If you view the site in US dollars or euros, the exact amount to be charged is shown before you confirm, in the settlement currency. The rate is locked when you order.',
            },
         },
         {
            question: {
               fr: "Je n'ai pas d'adresse e-mail. Puis-je réserver ?",
               en: 'I have no email address. Can I still book?',
            },
            answer: {
               fr: 'Oui. Votre numéro de téléphone suffit. La confirmation, la référence et les instructions arrivent par SMS, et un lien vous permet de définir un mot de passe pour suivre votre réservation.',
               en: 'Yes. Your phone number is enough. The confirmation, reference and instructions arrive by SMS, and a link lets you set a password to track your booking.',
            },
         },
         {
            question: {
               fr: 'Quand vais-je recevoir mon billet ou mon voucher ?',
               en: 'When do I get my ticket or voucher?',
            },
            answer: {
               fr: "Sous 24 heures ouvrées après confirmation du paiement. Les documents apparaissent dans votre compte et vous recevez un SMS. Nous n'envoyons jamais un document par un lien public permanent.",
               en: 'Within 24 working hours of payment being confirmed. Documents appear in your account and you get an SMS. We never send a document as a permanent public link.',
            },
         },
         {
            question: {
               fr: 'Que se passe-t-il si la compagnie annule mon vol ?',
               en: 'What if the airline cancels my flight?',
            },
            answer: {
               fr: 'Contactez-nous immédiatement. Ces situations ne relèvent pas de la politique de non-remboursement : elles sont traitées au cas par cas par la direction, qui vous propose une solution.',
               en: 'Contact us immediately. These situations fall outside the no-refund policy: they are handled case by case by management, who will propose a solution.',
            },
         },
         {
            question: {
               fr: 'Puis-je acheter un bien immobilier en ligne ?',
               en: 'Can I buy a property online?',
            },
            answer: {
               fr: "Non. L'immobilier se traite uniquement par contact direct avec notre agent : visite, vérification des documents chez le notaire, puis transaction hors plateforme. Le site sert à vous mettre en relation.",
               en: 'No. Property is handled only through direct contact with our agent: a viewing, document checks at the notary, then a transaction off the platform. The site is there to put you in touch.',
            },
         },
      ],
      contactTitle: { fr: "Vous n'avez pas trouvé ?", en: 'Still stuck?' },
      contactText: {
         fr: 'Appelez-nous ou écrivez sur WhatsApp du lundi au samedi, 08 h 00 – 18 h 00.',
         en: 'Call us or message on WhatsApp, Monday to Saturday, 08:00 – 18:00.',
      },
   },

   footer: {
      tagline: {
         fr: 'Vols, hôtels, transferts et immobilier en RDC',
         en: 'Flights, hotels, transfers and property in the DRC',
      },
      /**
       * The no-refund reminder. The footer carries it on every page, and the
       * same sentence stands beside the price on every offer and at checkout.
       */
      notice: {
         fr: "Toutes les ventes sont définitives. Aucun remboursement n'est accordé, quelle que soit la raison de l'annulation. Vous pouvez annuler une réservation, mais aucune somme ne sera restituée.",
         en: 'All sales are final. No refund is given, whatever the reason for cancellation. You may cancel a booking, but no money will be returned.',
      },
      /** The bold words in front of that sentence, wherever it stands beside a price. */
      noticeTitle: { fr: 'Réservation définitive', en: 'Final booking' },
      /** The same reminder where only a few words fit: the badge on offer cards. */
      noticeShort: {
         fr: 'Réservation définitive · non remboursable',
         en: 'Final booking · non-refundable',
      },
      /** Printed after "© 2026 " — the site adds the year itself. */
      copyright: {
         fr: 'Flexi Agency. Tous droits réservés.',
         en: 'Flexi Agency. All rights reserved.',
      },
   },
}
