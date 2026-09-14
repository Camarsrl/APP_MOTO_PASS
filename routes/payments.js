const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');
const stripe = require('../utils/stripe');

// URL pubblico del backend, usato per costruire i link di ritorno
// dell'onboarding Stripe Connect (pagine servite da questo stesso server,
// vedi in fondo al file). Se non impostata usiamo l'indirizzo Render noto.
const BACKEND_URL = process.env.BACKEND_URL || 'https://motopass-backend.onrender.com';

// ================================
// PASSEGGERO: SALVA UN METODO DI PAGAMENTO
// ================================
// Il passeggero paga sempre a fine corsa/consegna con una carta salvata in
// anticipo: qui creiamo solo il "SetupIntent" che permette all'app di
// raccogliere i dati della carta direttamente con Stripe (il nostro server
// non vede mai il numero della carta).
router.post('/setup-intent', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'passeggero') {
    return res.status(403).json({ errore: 'Solo i passeggeri possono salvare un metodo di pagamento' });
  }

  try {
    const utente = await pool.query(
      'SELECT stripe_customer_id, email, nome, cognome FROM users WHERE id = $1',
      [req.utente.id]
    );
    if (utente.rows.length === 0) {
      return res.status(404).json({ errore: 'Utente non trovato' });
    }

    let clienteId = utente.rows[0].stripe_customer_id;

    if (!clienteId) {
      const cliente = await stripe.customers.create({
        email: utente.rows[0].email,
        name: `${utente.rows[0].nome} ${utente.rows[0].cognome}`,
        metadata: { moto_pass_user_id: String(req.utente.id) }
      });
      clienteId = cliente.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [clienteId, req.utente.id]);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: clienteId,
      payment_method_types: ['card'],
      usage: 'off_session'
    });

    res.json({
      client_secret: setupIntent.client_secret,
      customer_id: clienteId
    });
  } catch (err) {
    console.error('Errore creazione SetupIntent:', err.message);
    res.status(500).json({ errore: 'Impossibile avviare il salvataggio della carta' });
  }
});

// ================================
// PASSEGGERO: CONFERMA IL METODO DI PAGAMENTO SALVATO
// ================================
// Chiamata dall'app subito dopo che Stripe ha confermato il SetupIntent sul
// telefono: qui salviamo solo l'id del metodo di pagamento (mai il numero
// di carta) e pochi dati non sensibili per mostrarlo nell'app.
router.post('/conferma-metodo', verificaToken, async (req, res) => {
  const { payment_method_id } = req.body;
  if (!payment_method_id) {
    return res.status(400).json({ errore: 'payment_method_id obbligatorio' });
  }

  try {
    const metodo = await stripe.paymentMethods.retrieve(payment_method_id);

    const utente = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.utente.id]);
    if (metodo.customer !== utente.rows[0]?.stripe_customer_id) {
      return res.status(403).json({ errore: 'Questo metodo di pagamento non appartiene al tuo account' });
    }

    await pool.query(
      `UPDATE users
       SET stripe_payment_method_id = $1, metodo_pagamento_marca = $2, metodo_pagamento_ultime4 = $3
       WHERE id = $4`,
      [payment_method_id, metodo.card?.brand || null, metodo.card?.last4 || null, req.utente.id]
    );

    res.json({
      messaggio: 'Carta salvata!',
      marca: metodo.card?.brand || null,
      ultime4: metodo.card?.last4 || null
    });
  } catch (err) {
    console.error('Errore conferma metodo di pagamento:', err.message);
    res.status(500).json({ errore: 'Impossibile salvare la carta' });
  }
});

// ================================
// STATO DEL METODO DI PAGAMENTO SALVATO (passeggero)
// ================================
router.get('/metodo', verificaToken, async (req, res) => {
  try {
    const utente = await pool.query(
      'SELECT stripe_payment_method_id, metodo_pagamento_marca, metodo_pagamento_ultime4 FROM users WHERE id = $1',
      [req.utente.id]
    );
    const u = utente.rows[0];
    res.json({
      presente: !!u?.stripe_payment_method_id,
      marca: u?.metodo_pagamento_marca || null,
      ultime4: u?.metodo_pagamento_ultime4 || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// RIMUOVI IL METODO DI PAGAMENTO SALVATO (passeggero)
// ================================
router.delete('/metodo', verificaToken, async (req, res) => {
  try {
    const utente = await pool.query('SELECT stripe_payment_method_id FROM users WHERE id = $1', [req.utente.id]);
    const pmId = utente.rows[0]?.stripe_payment_method_id;

    if (pmId) {
      await stripe.paymentMethods.detach(pmId).catch((err) => {
        // Se Stripe non lo trova più (es. già staccato) non blocchiamo la rimozione lato nostro.
        console.warn('Impossibile staccare il metodo da Stripe:', err.message);
      });
    }

    await pool.query(
      `UPDATE users
       SET stripe_payment_method_id = NULL, metodo_pagamento_marca = NULL, metodo_pagamento_ultime4 = NULL
       WHERE id = $1`,
      [req.utente.id]
    );

    res.json({ messaggio: 'Metodo di pagamento rimosso' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CONDUCENTE: COLLEGA I PAGAMENTI (Stripe Connect Express)
// ================================
// Restituisce un link di onboarding ospitato da Stripe: l'app lo apre nel
// browser (url_launcher), il conducente inserisce lì i propri dati per
// ricevere gli accrediti automatici, poi torna nell'app.
router.post('/conducente/connetti', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono collegare i pagamenti' });
  }

  try {
    const utente = await pool.query('SELECT stripe_account_id, email FROM users WHERE id = $1', [req.utente.id]);
    let accountId = utente.rows[0]?.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'IT',
        email: utente.rows[0]?.email,
        business_type: 'individual',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });
      accountId = account.id;
      await pool.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [accountId, req.utente.id]);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BACKEND_URL}/api/pagamenti/onboarding/aggiorna`,
      return_url: `${BACKEND_URL}/api/pagamenti/onboarding/ritorno`,
      type: 'account_onboarding'
    });

    res.json({ url: link.url });
  } catch (err) {
    console.error('Errore Stripe Connect:', err.message);
    res.status(500).json({ errore: 'Impossibile avviare il collegamento con Stripe' });
  }
});

// ================================
// CONDUCENTE: STATO DEL COLLEGAMENTO PAGAMENTI
// ================================
router.get('/conducente/stato', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti' });
  }

  try {
    const utente = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [req.utente.id]);
    const accountId = utente.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.json({ collegato: false, pronto: false });
    }

    const account = await stripe.accounts.retrieve(accountId);
    const pronto = !!(account.charges_enabled && account.payouts_enabled);

    await pool.query('UPDATE conducenti SET stripe_connect_pronto = $1 WHERE user_id = $2', [pronto, req.utente.id]);

    res.json({ collegato: true, pronto });
  } catch (err) {
    console.error('Errore stato Stripe Connect:', err.message);
    res.status(500).json({ errore: 'Impossibile verificare lo stato del collegamento' });
  }
});

// ================================
// PAGINE DI RITORNO DALL'ONBOARDING STRIPE (aperte nel browser, senza login)
// ================================
// Stripe reindirizza qui il browser al termine (o refresh_url se il link è
// scaduto): sono semplici pagine informative, il conducente torna
// manualmente nell'app e la schermata "Pagamenti" verifica lo stato reale.
router.get('/onboarding/ritorno', (req, res) => {
  res.send(paginaOnboarding(
    'Collegamento completato',
    'Puoi tornare all\'app Moto Pass: la schermata "Pagamenti" mostrerà a breve lo stato aggiornato.'
  ));
});

router.get('/onboarding/aggiorna', (req, res) => {
  res.send(paginaOnboarding(
    'Link scaduto',
    'Torna all\'app Moto Pass e tocca di nuovo "Collega pagamenti" per generarne uno nuovo.'
  ));
});

function paginaOnboarding(titolo, messaggio) {
  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moto Pass</title>
<style>body{font-family:sans-serif;background:#1A2C6B;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}
.scatola{max-width:360px}h1{font-size:20px}p{opacity:.85;line-height:1.5}</style>
</head><body><div class="scatola"><h1>🛵 ${titolo}</h1><p>${messaggio}</p></div></body></html>`;
}

// ================================
// ADDEBITO AL PASSEGGERO A FINE CORSA/CONSEGNA
// ================================
// Usata da routes/rides.js (PUT /:id/completa) e routes/consegne.js
// (PUT /:id/consegnata). Non blocca mai il completamento del
// passaggio/consegna: se il pagamento fallisce (carta assente, rifiutata,
// o richiede una conferma 3D Secure che qui non possiamo gestire perché il
// passeggero non è nell'app in quel momento) restituiamo solo l'esito, e
// chi chiama registra "fallito" senza interrompere nulla.
async function eseguiAddebito({ tipo, riferimentoId, passeggeroId, conducenteId, importoPasseggero, importoConducente, commissioneApp }) {
  try {
    const passeggero = await pool.query(
      'SELECT stripe_customer_id, stripe_payment_method_id FROM users WHERE id = $1',
      [passeggeroId]
    );
    const p = passeggero.rows[0];
    if (!p?.stripe_customer_id || !p?.stripe_payment_method_id) {
      throw Object.assign(new Error('Nessun metodo di pagamento salvato'), { code: 'nessun_metodo' });
    }

    const conducente = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [conducenteId]);
    const contoConducente = conducente.rows[0]?.stripe_account_id;

    const parametri = {
      amount: Math.round(importoPasseggero * 100),
      currency: 'eur',
      customer: p.stripe_customer_id,
      payment_method: p.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Moto Pass - ${tipo} #${riferimentoId}`
    };

    // Se il conducente ha già collegato Stripe Connect, l'accredito parte
    // automaticamente verso di lui (destination charge): riceve
    // importoConducente, la app trattiene commissioneApp. Se non l'ha ancora
    // collegato, l'importo resta sul conto Moto Pass finché non lo collega
    // (nessun accredito automatico possibile senza un conto di destinazione).
    if (contoConducente) {
      parametri.transfer_data = { destination: contoConducente };
      parametri.application_fee_amount = Math.round(commissioneApp * 100);
    }

    const intent = await stripe.paymentIntents.create(parametri);

    await pool.query(
      `INSERT INTO pagamenti (corsa_id, consegna_id, passeggero_id, conducente_id, importo, stato, stripe_payment_id, tipo)
       VALUES ($1, $2, $3, $4, $5, 'completato', $6, $7)`,
      [
        tipo === 'corsa' ? riferimentoId : null,
        tipo === 'consegna' ? riferimentoId : null,
        passeggeroId, conducenteId, importoPasseggero, intent.id, tipo
      ]
    );

    return { riuscito: true, paymentIntentId: intent.id };
  } catch (err) {
    console.error('Errore addebito Stripe:', err.message);

    await pool.query(
      `INSERT INTO pagamenti (corsa_id, consegna_id, passeggero_id, conducente_id, importo, stato, tipo)
       VALUES ($1, $2, $3, $4, $5, 'fallito', $6)`,
      [
        tipo === 'corsa' ? riferimentoId : null,
        tipo === 'consegna' ? riferimentoId : null,
        passeggeroId, conducenteId, importoPasseggero, tipo
      ]
    ).catch((e) => console.error('Impossibile registrare il pagamento fallito:', e.message));

    return { riuscito: false, motivoErrore: err.code === 'nessun_metodo'
      ? 'Il passeggero non ha una carta salvata'
      : (err.code === 'authentication_required'
        ? 'Il pagamento richiede una conferma aggiuntiva (3D Secure) da parte del passeggero'
        : 'Pagamento rifiutato') };
  }
}

// ================================
// WEBHOOK STRIPE
// ================================
// IMPORTANTE: questa funzione va montata in server.js con express.raw()
// PRIMA di express.json(), altrimenti la verifica della firma fallisce
// sempre (Stripe firma il body "grezzo", non quello già interpretato come
// JSON). Non è quindi registrata come router.post qui dentro: viene
// esportata e agganciata direttamente su app in server.js.
async function gestisciWebhook(req, res) {
  const firma = req.headers['stripe-signature'];
  let evento;

  try {
    evento = stripe.webhooks.constructEvent(req.body, firma, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Firma webhook Stripe non valida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (evento.type === 'account.updated') {
      const account = evento.data.object;
      const pronto = !!(account.charges_enabled && account.payouts_enabled);
      await pool.query(
        `UPDATE conducenti SET stripe_connect_pronto = $1
         WHERE user_id = (SELECT id FROM users WHERE stripe_account_id = $2)`,
        [pronto, account.id]
      );
    }

    if (evento.type === 'payment_intent.payment_failed') {
      const intent = evento.data.object;
      await pool.query(`UPDATE pagamenti SET stato = 'fallito' WHERE stripe_payment_id = $1`, [intent.id]);
    }
  } catch (err) {
    // Un errore nella gestione non deve far ritentare Stripe all'infinito
    // un evento che comunque non possiamo più elaborare diversamente.
    console.error('Errore gestione webhook Stripe:', err.message);
  }

  res.json({ received: true });
}

module.exports = router;
module.exports.eseguiAddebito = eseguiAddebito;
module.exports.gestisciWebhook = gestisciWebhook;
