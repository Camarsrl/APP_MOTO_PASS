const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');

// Costo rimborso per km (benzina + spese)
const COSTO_PER_KM = 0.25; // €0.25 per km

// Fasce di cilindrata valide (le stesse usate in registrazione conducente)
const CILINDRATE_VALIDE = ['fino_50', '51_125', '126_300', 'oltre_300'];

// ================================
// CERCA CONDUCENTI VICINI
// ================================
router.get('/conducenti-vicini', verificaToken, async (req, res) => {
  const { lat, lng, raggio = 5, cilindrata } = req.query; // raggio in km

  const filtroCilindrata = CILINDRATE_VALIDE.includes(cilindrata) ? cilindrata : null;

  try {
    const risultato = await pool.query(
      `SELECT u.id, u.nome, u.cognome, u.foto_profilo,
              c.marca_moto, c.modello_moto, c.targa_moto, c.cilindrata,
              c.valutazione_media, c.totale_corse,
              c.latitudine, c.longitudine,
              -- Calcola distanza in km (formula Haversine)
              (6371 * acos(
                cos(radians($1)) * cos(radians(c.latitudine)) *
                cos(radians(c.longitudine) - radians($2)) +
                sin(radians($1)) * sin(radians(c.latitudine))
              )) AS distanza_km
       FROM users u
       JOIN conducenti c ON u.id = c.user_id
       WHERE c.disponibile = true
         AND c.verificato = true
         AND u.attivo = true
         AND c.latitudine IS NOT NULL
         AND ($4::VARCHAR IS NULL OR c.cilindrata = $4)
       HAVING (6371 * acos(
         cos(radians($1)) * cos(radians(c.latitudine)) *
         cos(radians(c.longitudine) - radians($2)) +
         sin(radians($1)) * sin(radians(c.latitudine))
       )) < $3
       ORDER BY distanza_km ASC
       LIMIT 10`,
      [lat, lng, raggio, filtroCilindrata]
    );

    res.json({
      conducenti: risultato.rows,
      totale: risultato.rows.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// RICHIEDI UNA CORSA
// ================================
// L'app non ha ancora una mappa: partenza/destinazione sono indirizzi
// testuali e la distanza è stimata manualmente dal passeggero (come per
// le consegne pacchi), quindi lat/lng sono opzionali.
router.post('/richiedi', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'passeggero') {
    return res.status(403).json({ errore: 'Solo i passeggeri possono richiedere corse' });
  }

  const {
    partenza_indirizzo, partenza_lat, partenza_lng,
    destinazione_indirizzo, destinazione_lat, destinazione_lng,
    distanza_km, cilindrata_preferita
  } = req.body;

  if (!partenza_indirizzo || !destinazione_indirizzo) {
    return res.status(400).json({ errore: 'Indirizzo di partenza e destinazione obbligatori' });
  }

  // La preferenza di cilindrata è facoltativa: "nessuna preferenza" se assente o non valida.
  const cilindrataFinale = CILINDRATE_VALIDE.includes(cilindrata_preferita)
    ? cilindrata_preferita
    : null;

  try {
    // Calcola rimborso solo se il passeggero ha indicato una distanza stimata
    const distanza = distanza_km ? parseFloat(distanza_km) : null;
    const rimborso = distanza ? (distanza * COSTO_PER_KM).toFixed(2) : null;

    const risultato = await pool.query(
      `INSERT INTO corse (
        passeggero_id, stato,
        partenza_indirizzo, partenza_lat, partenza_lng,
        destinazione_indirizzo, destinazione_lat, destinazione_lng,
        distanza_km, cilindrata_preferita, rimborso_calcolato
      ) VALUES ($1, 'in_attesa', $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        req.utente.id,
        partenza_indirizzo, partenza_lat || null, partenza_lng || null,
        destinazione_indirizzo, destinazione_lat || null, destinazione_lng || null,
        distanza, cilindrataFinale, rimborso
      ]
    );

    const corsa = risultato.rows[0];

    res.status(201).json({
      messaggio: 'Corsa richiesta! Cerco conducente...',
      corsa,
      rimborso_stimato: rimborso ? `€${rimborso}` : null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CORSE DISPONIBILI (per conducenti, senza bisogno di posizione GPS)
// ================================
router.get('/disponibili', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono vedere le corse disponibili' });
  }

  try {
    const risultato = await pool.query(
      `SELECT c.*, u.nome AS nome_passeggero, u.cognome AS cognome_passeggero
       FROM corse c
       JOIN users u ON c.passeggero_id = u.id
       WHERE c.stato = 'in_attesa'
       ORDER BY c.creata_il DESC
       LIMIT 30`
    );

    res.json({ corse: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// ACCETTA CORSA (conducente)
// ================================
router.put('/:id/accetta', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono accettare corse' });
  }

  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'accettata', conducente_id = $1
       WHERE id = $2 AND stato = 'in_attesa'
       RETURNING *`,
      [req.utente.id, req.params.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata o già accettata' });
    }

    res.json({
      messaggio: 'Corsa accettata! Vai dal passeggero.',
      corsa: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// INIZIA CORSA (conducente)
// ================================
router.put('/:id/inizia', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'in_corso', iniziata_il = NOW()
       WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }

    res.json({
      messaggio: 'Corsa iniziata! Buon viaggio! 🛵',
      corsa: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// COMPLETA CORSA (conducente)
// ================================
router.put('/:id/completa', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'completata', completata_il = NOW(),
           rimborso_finale = rimborso_calcolato
       WHERE id = $1 AND conducente_id = $2 AND stato = 'in_corso'
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }

    res.json({
      messaggio: 'Corsa completata! Il rimborso sarà accreditato a breve.',
      corsa: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// STORICO CORSE UTENTE
// ================================
router.get('/storico', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT c.*,
              p.nome AS nome_passeggero, p.cognome AS cognome_passeggero, p.foto_profilo AS foto_passeggero,
              co.nome AS nome_conducente, co.cognome AS cognome_conducente, co.foto_profilo AS foto_conducente
       FROM corse c
       LEFT JOIN users p ON c.passeggero_id = p.id
       LEFT JOIN users co ON c.conducente_id = co.id
       WHERE c.passeggero_id = $1 OR c.conducente_id = $1
       ORDER BY c.creata_il DESC
       LIMIT 20`,
      [req.utente.id]
    );

    res.json({ corse: risultato.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// AGGIORNA POSIZIONE CONDUCENTE
// ================================
router.put('/posizione', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti' });
  }

  const { latitudine, longitudine, disponibile } = req.body;

  try {
    await pool.query(
      `UPDATE conducenti
       SET latitudine = $1, longitudine = $2, disponibile = $3
       WHERE user_id = $4`,
      [latitudine, longitudine, disponibile, req.utente.id]
    );

    res.json({ messaggio: 'Posizione aggiornata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
