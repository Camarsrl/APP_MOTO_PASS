const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const stripe = require('../utils/stripe');

// ================================
// AREA AMMINISTRAZIONE (verifica documenti conducenti)
// ================================
// Non esiste (ancora) un ruolo "admin" separato in users: l'accesso a
// queste rotte è protetto da un segreto condiviso, impostato come
// variabile d'ambiente ADMIN_SECRET su Render e inserito nell'app dalla
// schermata di amministrazione (nascosta, non collegata al menu normale).
// Se ADMIN_SECRET non è impostato sul server, blocchiamo tutto per
// sicurezza (nessun accesso "di default").
const CAMPI_VERIFICA_VALIDI = [
  'verificato',
  'patente_verificata',
  'assicurazione_verificata',
  'casco_passeggero_disponibile',
  'cuffia_igienica_disponibile',
];

function verificaSegretoAdmin(req, res, next) {
  const segreto = process.env.ADMIN_SECRET;
  const fornito = req.header('x-admin-secret');
  if (!segreto || !fornito || fornito !== segreto) {
    return res.status(401).json({ errore: 'Accesso amministrazione non autorizzato' });
  }
  next();
}

// Elenco conducenti con lo stato attuale dei bollini di verifica, per la
// schermata di amministrazione nell'app.
router.get('/conducenti', verificaSegretoAdmin, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT u.id, u.nome, u.cognome, u.telefono, u.email,
              c.targa_moto, c.marca_moto, c.modello_moto, c.numero_patente, c.tipo_veicolo,
              c.avatar_id, c.verificato, c.patente_verificata,
              c.assicurazione_verificata, c.casco_passeggero_disponibile,
              c.cuffia_igienica_disponibile
       FROM users u
       JOIN conducenti c ON u.id = c.user_id
       WHERE u.ruolo = 'conducente'
       ORDER BY u.creato_il DESC`
    );
    res.json({ conducenti: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// Attiva/disattiva un singolo bollino di verifica per un conducente.
// Un solo campo per chiamata, per evitare di modificare per sbaglio più
// bollini con una singola richiesta.
router.put('/conducenti/:id/verifica', verificaSegretoAdmin, async (req, res) => {
  const { campo, valore } = req.body;

  if (!CAMPI_VERIFICA_VALIDI.includes(campo)) {
    return res.status(400).json({ errore: 'Campo di verifica non valido' });
  }
  if (typeof valore !== 'boolean') {
    return res.status(400).json({ errore: 'Il valore deve essere true o false' });
  }

  try {
    // campo è validato sopra contro una whitelist fissa, quindi è sicuro
    // usarlo per comporre il nome colonna (non arriva mai libero dall'utente).
    const risultato = await pool.query(
      `UPDATE conducenti SET ${campo} = $1
       WHERE user_id = $2
       RETURNING user_id, ${campo}`,
      [valore, req.params.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Conducente non trovato' });
    }

    res.json({ messaggio: 'Bollino aggiornato', ...risultato.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// SEGNALAZIONI DI PACCHI SMARRITI
// ================================
// Elenco delle segnalazioni aperte, per decidere caso per caso (mai in modo
// automatico) se rimborsare il mittente. richiede_operatore e riepilogo_ia
// (dentro s.*) sono impostati dall'assistente IA quando la situazione va
// oltre quello che può gestire da solo: quelle segnalazioni vengono per
// prime, così chi fa assistenza le vede subito.
router.get('/segnalazioni-smarrimento', verificaSegretoAdmin, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT s.*,
              c.descrizione_oggetto, c.categoria, c.ritiro_indirizzo, c.consegna_indirizzo,
              c.rimborso_calcolato, c.stato AS stato_consegna,
              m.nome AS nome_mittente, m.cognome AS cognome_mittente, m.email AS email_mittente,
              co.nome AS nome_conducente, co.cognome AS cognome_conducente,
              p.stripe_payment_id, p.stato AS stato_pagamento
       FROM segnalazioni_smarrimento s
       JOIN consegne c ON s.consegna_id = c.id
       JOIN users m ON s.mittente_id = m.id
       LEFT JOIN users co ON c.conducente_id = co.id
       LEFT JOIN pagamenti p ON p.consegna_id = c.id
       WHERE s.stato = 'aperta'
       ORDER BY s.richiede_operatore DESC, s.creata_il ASC`
    );
    res.json({ segnalazioni: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// Chiude una segnalazione. Se rimborsa=true e la consegna è stata pagata
// con carta, rimborsiamo il mittente su Stripe: con reverse_transfer:true
// Stripe recupera automaticamente anche la parte già accreditata al
// conducente (se aveva già collegato Stripe Connect).
router.put('/segnalazioni-smarrimento/:id/risolvi', verificaSegretoAdmin, async (req, res) => {
  const rimborsa = req.body.rimborsa === true;
  const note = req.body.note?.toString().trim() || null;

  try {
    const segnalazione = await pool.query(
      `SELECT * FROM segnalazioni_smarrimento WHERE id = $1 AND stato = 'aperta'`,
      [req.params.id]
    );
    if (segnalazione.rows.length === 0) {
      return res.status(404).json({ errore: 'Segnalazione non trovata o già chiusa' });
    }
    const s = segnalazione.rows[0];

    let esitoRimborso = null;
    if (rimborsa) {
      const pagamento = await pool.query(
        `SELECT * FROM pagamenti WHERE consegna_id = $1 AND stato = 'completato' LIMIT 1`,
        [s.consegna_id]
      );
      if (pagamento.rows.length === 0 || !pagamento.rows[0].stripe_payment_id) {
        return res.status(400).json({
          errore: 'Nessun pagamento riuscito trovato per questa consegna: rimborso non possibile da qui'
        });
      }
      try {
        await stripe.refunds.create({
          payment_intent: pagamento.rows[0].stripe_payment_id,
          reverse_transfer: true
        });
        await pool.query(`UPDATE pagamenti SET stato = 'rimborsato' WHERE id = $1`, [pagamento.rows[0].id]);
        esitoRimborso = 'rimborsato';
      } catch (err) {
        console.error('Errore rimborso Stripe:', err.message);
        return res.status(500).json({ errore: `Rimborso Stripe non riuscito: ${err.message}` });
      }
    } else {
      await pool.query(`UPDATE pagamenti SET contestato = false WHERE consegna_id = $1`, [s.consegna_id]);
    }

    const aggiornata = await pool.query(
      `UPDATE segnalazioni_smarrimento
       SET stato = $1, note_risoluzione = $2, risolta_il = NOW()
       WHERE id = $3
       RETURNING *`,
      [rimborsa ? 'risolta_rimborsata' : 'risolta_senza_rimborso', note, req.params.id]
    );

    res.json({ messaggio: 'Segnalazione chiusa', segnalazione: aggiornata.rows[0], rimborso: esitoRimborso });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
