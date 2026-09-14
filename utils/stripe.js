// Client Stripe condiviso da tutte le routes che ne hanno bisogno.
// STRIPE_SECRET_KEY va impostata come variabile d'ambiente su Render
// (mai nel codice, mai condivisa in chat): stesso procedimento già usato
// per ADMIN_SECRET e JWT_SECRET.
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn(
    '⚠️  STRIPE_SECRET_KEY non impostata: i pagamenti non funzioneranno finché ' +
    'non la aggiungi tra le variabili d\'ambiente su Render.'
  );
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

module.exports = stripe;
