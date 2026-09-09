const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');

// ================================
// CREA PAGAMENTO PER UNA CORSA
// ================================
router.post('/crea/:corsa_id', verificaToken, async (req, res) => {
  try {
    // Prendi i dettagli della corsa
    const corsa = await pool.query(
      'SELECT * FROM corse WHERE id = $1 AND passeggero_id = $2',
      [req.params.corsa_id, req.utente.id]
    );

    if (corsa.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }

    const importo = corsa.rows[0].rimborso_calcolato;

    // Crea PaymentIntent su Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(importo * 100), // Stripe usa i centesimi
      currency: 'eur',
      metadata: {
        corsa_id: req.params.corsa_id,
        passeggero_id: req.utente.id.toString()
      },
      description: `Rimborso spese Moto Pass - Corsa #${req.params.corsa_id}`
    });

    // Salva il payment intent nella corsa
    await pool.query(
      'UPDATE corse SET stripe_payment_intent = $1 WHERE id = $2',
      [paymentIntent.id, req.params.corsa_id]
    );

    res.json({
      client_secret: paymentIntent.client_secret,
      importo: importo,
      importo_formattato: `€${importo}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore nella creazione del pagamento' });
  }
});

// ================================
// CONFERMA PAGAMENTO COMPLETATO
// ================================
router.post('/conferma/:corsa_id', verificaToken, async (req, res) => {
  const { payment_intent_id } = req.body;

  try {
    // Verifica su Stripe che il pagamento sia andato a buon fine
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ errore: 'Pagamento non completato' });
    }

    // Aggiorna il database
    const corsa = await pool.query(
      `UPDATE corse SET stato = 'completata', rimborso_finale = rimborso_calcolato
       WHERE id = $1 RETURNING *`,
      [req.params.corsa_id]
    );

    // Salva il pagamento
    await pool.query(
      `INSERT INTO pagamenti (corsa_id, passeggero_id, conducente_id, importo, stato, stripe_payment_id)
       VALUES ($1, $2, $3, $4, 'completato', $5)`,
      [
        req.params.corsa_id,
        corsa.rows[0].passeggero_id,
        corsa.rows[0].conducente_id,
        corsa.rows[0].rimborso_finale,
        payment_intent_id
      ]
    );

    res.json({
      messaggio: '✅ Pagamento completato! Il conducente riceverà il rimborso.',
      corsa: corsa.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore nella conferma del pagamento' });
  }
});

// ================================
// STORICO PAGAMENTI
// ================================
router.get('/storico', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT p.*, 
              c.partenza_indirizzo, c.destinazione_indirizzo,
              c.distanza_km
       FROM pagamenti p
       JOIN corse c ON p.corsa_id = c.id
       WHERE p.passeggero_id = $1 OR p.conducente_id = $1
       ORDER BY p.creato_il DESC`,
      [req.utente.id]
    );

    res.json({ pagamenti: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
