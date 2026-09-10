const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');
const { conducenteSospeso, registraVotoConducente } = require('../utils/recensioni');

// ================================
// LIMITI E TARIFFE CONSEGNA PACCHI
// ================================
// Valori "ragionevoli" di partenza: facili da cambiare qui in un unico punto
// non appena i responsabili confermano i limiti definitivi.
const PESO_MASSIMO_KG = 5;        // peso massimo del pacco
const DIMENSIONE_MASSIMA_CM = 40; // lato più lungo del pacco, in cm
const SUPPLEMENTO_FISSO = 1.0;    // € fissi per ogni consegna
const COSTO_PER_KM = 0.2;         // € per km, oltre al supplemento fisso

// ================================
// RICHIEDI UNA CONSEGNA (mittente)
// ================================
// Qualunque utente registrato (passeggero o conducente) può spedire un
// pacco: non è richiesto un ruolo specifico.
router.post('/richiedi', verificaToken, async (req, res) => {
  const {
    ritiro_indirizzo, ritiro_lat, ritiro_lng,
    consegna_indirizzo, consegna_lat, consegna_lng,
    descrizione_oggetto, peso_kg, dimensione_cm,
    distanza_km, destinatario_nome, destinatario_telefono, note
  } = req.body;

  if (!ritiro_indirizzo || !consegna_indirizzo || !descrizione_oggetto ||
      peso_kg === undefined || dimensione_cm === undefined ||
      !destinatario_nome || !destinatario_telefono) {
    return res.status(400).json({ errore: 'Compila tutti i campi obbligatori' });
  }

  const peso = parseFloat(peso_kg);
  const dimensione = parseFloat(dimensione_cm);

  if (isNaN(peso) || peso <= 0 || isNaN(dimensione) || dimensione <= 0) {
    return res.status(400).json({ errore: 'Peso e dimensione devono essere numeri validi' });
  }

  if (peso > PESO_MASSIMO_KG) {
    return res.status(400).json({
      errore: `Il peso massimo consentito è ${PESO_MASSIMO_KG} kg`
    });
  }

  if (dimensione > DIMENSIONE_MASSIMA_CM) {
    return res.status(400).json({
      errore: `La dimensione massima consentita è ${DIMENSIONE_MASSIMA_CM} cm sul lato più lungo`
    });
  }

  try {
    const distanza = distanza_km ? parseFloat(distanza_km) : null;
    const rimborso = distanza
      ? (SUPPLEMENTO_FISSO + distanza * COSTO_PER_KM).toFixed(2)
      : null;

    const risultato = await pool.query(
      `INSERT INTO consegne (
        mittente_id, stato,
        ritiro_indirizzo, ritiro_lat, ritiro_lng,
        consegna_indirizzo, consegna_lat, consegna_lng,
        descrizione_oggetto, peso_kg, dimensione_cm, distanza_km,
        destinatario_nome, destinatario_telefono, note,
        rimborso_calcolato
      ) VALUES ($1, 'richiesta', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        req.utente.id,
        ritiro_indirizzo, ritiro_lat || null, ritiro_lng || null,
        consegna_indirizzo, consegna_lat || null, consegna_lng || null,
        descrizione_oggetto, peso, dimensione, distanza,
        destinatario_nome, destinatario_telefono, note || null,
        rimborso
      ]
    );

    res.status(201).json({
      messaggio: 'Richiesta di consegna creata!',
      consegna: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CONSEGNE DISPONIBILI (per conducenti)
// ================================
router.get('/disponibili', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono vedere le consegne disponibili' });
  }

  try {
    const risultato = await pool.query(
      `SELECT c.*, u.nome AS nome_mittente, u.cognome AS cognome_mittente
       FROM consegne c
       JOIN users u ON c.mittente_id = u.id
       WHERE c.stato = 'richiesta'
       ORDER BY c.creata_il DESC
       LIMIT 30`
    );

    res.json({ consegne: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// ACCETTA CONSEGNA (conducente)
// ================================
router.put('/:id/accetta', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono accettare consegne' });
  }

  const { sospeso, sospesoFino } = await conducenteSospeso(req.utente.id);
  if (sospeso) {
    const data = new Date(sospesoFino).toLocaleDateString('it-IT');
    return res.status(403).json({
      errore: `Il tuo account conducente è sospeso fino al ${data} per troppe recensioni negative`
    });
  }

  try {
    const risultato = await pool.query(
      `UPDATE consegne
       SET stato = 'accettata', conducente_id = $1, accettata_il = NOW()
       WHERE id = $2 AND stato = 'richiesta'
       RETURNING *`,
      [req.utente.id, req.params.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata o già accettata' });
    }

    res.json({
      messaggio: 'Consegna accettata! Vai a ritirare il pacco.',
      consegna: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// SEGNA PACCO RITIRATO (conducente)
// ================================
router.put('/:id/ritirata', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE consegne
       SET stato = 'ritirata', ritirata_il = NOW()
       WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata' });
    }

    res.json({
      messaggio: 'Pacco ritirato! 📦',
      consegna: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// SEGNA PACCO CONSEGNATO (conducente)
// ================================
router.put('/:id/consegnata', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE consegne
       SET stato = 'consegnata', consegnata_il = NOW(),
           rimborso_finale = rimborso_calcolato
       WHERE id = $1 AND conducente_id = $2 AND stato = 'ritirata'
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata' });
    }

    res.json({
      messaggio: 'Consegna completata! ✅',
      consegna: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// RECENSISCI IL CONDUCENTE (mittente, dopo una consegna completata)
// ================================
router.post('/:id/recensisci', verificaToken, async (req, res) => {
  const voto = parseInt(req.body.voto, 10);
  if (isNaN(voto) || voto < 1 || voto > 5) {
    return res.status(400).json({ errore: 'Il voto deve essere un numero da 1 a 5' });
  }

  try {
    const consegna = await pool.query(
      `SELECT * FROM consegne WHERE id = $1 AND mittente_id = $2`,
      [req.params.id, req.utente.id]
    );

    if (consegna.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata' });
    }

    const c = consegna.rows[0];

    if (c.stato !== 'consegnata') {
      return res.status(400).json({ errore: 'Puoi recensire solo una consegna completata' });
    }
    if (!c.conducente_id) {
      return res.status(400).json({ errore: 'Questa consegna non ha un conducente associato' });
    }
    if (c.valutazione_conducente !== null) {
      return res.status(400).json({ errore: 'Hai già recensito questa consegna' });
    }

    await pool.query(
      `UPDATE consegne SET valutazione_conducente = $1 WHERE id = $2`,
      [voto, req.params.id]
    );

    await registraVotoConducente(c.conducente_id, voto);

    res.json({ messaggio: 'Recensione registrata, grazie!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// ANNULLA CONSEGNA (mittente, solo se non ancora accettata)
// ================================
router.put('/:id/annulla', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE consegne
       SET stato = 'annullata'
       WHERE id = $1 AND mittente_id = $2 AND stato = 'richiesta'
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata o già in corso' });
    }

    res.json({
      messaggio: 'Consegna annullata',
      consegna: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// LE MIE CONSEGNE (inviate o in carico come conducente)
// ================================
router.get('/mie', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT c.*,
              m.nome AS nome_mittente, m.cognome AS cognome_mittente,
              co.nome AS nome_conducente, co.cognome AS cognome_conducente
       FROM consegne c
       JOIN users m ON c.mittente_id = m.id
       LEFT JOIN users co ON c.conducente_id = co.id
       WHERE c.mittente_id = $1 OR c.conducente_id = $1
       ORDER BY c.creata_il DESC
       LIMIT 20`,
      [req.utente.id]
    );

    res.json({ consegne: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
