const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');
const { conducenteSospeso, registraVotoConducente } = require('../utils/recensioni');

// Tariffa pagata dal passeggero: €1 al km, con una spesa minima di €4
// a corsa (anche per tragitti brevissimi).
const TARIFFA_PASSEGGERO_PER_KM = 1.0; // €1,00 per km
const MINIMO_PASSEGGERO = 4.0;         // € minimo per corsa

// L'app trattiene il 30% di quanto paga realmente il passeggero (minimo
// incluso); il conducente riceve il restante 70%.
const COMMISSIONE_APP = 0.30; // 30%

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
         AND (c.sospeso_fino IS NULL OR c.sospeso_fino <= NOW())
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
// L'app non ha ancora una mappa: partenza/destinazione sono solo indirizzi
// testuali, quindi lat/lng sono opzionali. Il passeggero NON indica più una
// distanza stimata: il rimborso viene calcolato a fine corsa sui km
// realmente percorsi, dichiarati dal conducente (vedi PUT /:id/completa).
router.post('/richiedi', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'passeggero') {
    return res.status(403).json({ errore: 'Solo i passeggeri possono richiedere corse' });
  }

  const {
    partenza_indirizzo, partenza_lat, partenza_lng,
    destinazione_indirizzo, destinazione_lat, destinazione_lng,
    cilindrata_preferita
  } = req.body;

  if (!partenza_indirizzo || !destinazione_indirizzo) {
    return res.status(400).json({ errore: 'Indirizzo di partenza e destinazione obbligatori' });
  }

  // La preferenza di cilindrata è facoltativa: "nessuna preferenza" se assente o non valida.
  const cilindrataFinale = CILINDRATE_VALIDE.includes(cilindrata_preferita)
    ? cilindrata_preferita
    : null;

  try {
    const risultato = await pool.query(
      `INSERT INTO corse (
        passeggero_id, stato,
        partenza_indirizzo, partenza_lat, partenza_lng,
        destinazione_indirizzo, destinazione_lat, destinazione_lng,
        cilindrata_preferita
      ) VALUES ($1, 'in_attesa', $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        req.utente.id,
        partenza_indirizzo, partenza_lat || null, partenza_lng || null,
        destinazione_indirizzo, destinazione_lat || null, destinazione_lng || null,
        cilindrataFinale
      ]
    );

    res.status(201).json({
      messaggio: 'Corsa richiesta! Cerco un conducente vicino a te...',
      corsa: risultato.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CORSE DISPONIBILI (per conducenti, senza bisogno di posizione GPS)
// ================================
// IMPORTANTE: questa route e /storico qui sotto devono restare PRIMA di
// GET /:id. Express fa il match delle route nell'ordine in cui sono
// definite, quindi se /:id fosse prima, una richiesta a /corse/disponibili
// o /corse/storico verrebbe interpretata come /:id con id="disponibili" (o
// "storico"), causando un errore del database (id non numerico).
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
// DETTAGLIO DI UNA CORSA
// ================================
// Usato dall'app sia dal lato passeggero (per seguire lo stato in tempo
// reale mentre aspetta/viaggia) sia dal lato conducente. Non essendoci
// ancora notifiche push, l'app interroga questo endpoint periodicamente.
router.get('/:id', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT c.*,
              p.nome AS nome_passeggero, p.cognome AS cognome_passeggero, p.foto_profilo AS foto_passeggero,
              co.nome AS nome_conducente, co.cognome AS cognome_conducente, co.foto_profilo AS foto_conducente,
              cd.targa_moto, cd.marca_moto, cd.modello_moto, cd.cilindrata,
              cd.valutazione_media AS valutazione_conducente_media,
              cd.avatar_id AS avatar_conducente,
              cd.verificato AS conducente_verificato,
              cd.patente_verificata, cd.assicurazione_verificata,
              cd.casco_passeggero_disponibile, cd.cuffia_igienica_disponibile,
              (SELECT COUNT(*) FROM (
                 SELECT valutazione_conducente FROM corse
                   WHERE conducente_id = c.conducente_id AND valutazione_conducente IS NOT NULL
                 UNION ALL
                 SELECT valutazione_conducente FROM consegne
                   WHERE conducente_id = c.conducente_id AND valutazione_conducente IS NOT NULL
               ) recensioni)::int AS numero_recensioni_conducente
       FROM corse c
       LEFT JOIN users p ON c.passeggero_id = p.id
       LEFT JOIN users co ON c.conducente_id = co.id
       LEFT JOIN conducenti cd ON c.conducente_id = cd.user_id
       WHERE c.id = $1 AND (c.passeggero_id = $2 OR c.conducente_id = $2)`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }

    res.json(risultato.rows[0]);
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

  const { sospeso, sospesoFino } = await conducenteSospeso(req.utente.id);
  if (sospeso) {
    const data = new Date(sospesoFino).toLocaleDateString('it-IT');
    return res.status(403).json({
      errore: `Il tuo account conducente è sospeso fino al ${data} per troppe recensioni negative`
    });
  }

  try {
    // Un conducente può avere un solo passaggio attivo alla volta: se ne ha
    // già uno accettato o in corso, blocchiamo l'accettazione di un altro
    // (altrimenti restano passaggi "fantasma" bloccati su In corso, mai
    // portati a termine, e la lista delle richieste disponibili si svuota
    // senza che nessuno l'abbia davvero presa in carico).
    const corsaAttiva = await pool.query(
      `SELECT id FROM corse
       WHERE conducente_id = $1 AND stato IN ('accettata', 'in_corso')
       LIMIT 1`,
      [req.utente.id]
    );
    if (corsaAttiva.rows.length > 0) {
      return res.status(409).json({
        errore: 'Hai già un passaggio in corso: completalo prima di accettarne un altro'
      });
    }

    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'accettata', conducente_id = $1, accettata_il = NOW()
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
// ANNULLA CORSA (passeggero, solo finché è ancora in attesa di un conducente)
// ================================
router.put('/:id/annulla', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'annullata'
       WHERE id = $1 AND passeggero_id = $2 AND stato = 'in_attesa'
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({
        errore: 'Corsa non trovata, oppure un conducente l\'ha già accettata'
      });
    }

    res.json({ messaggio: 'Richiesta annullata', corsa: risultato.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// ELIMINA CORSA ANNULLATA (passeggero, pulizia dello storico)
// ================================
// Una corsa può essere annullata solo mentre è ancora 'in_attesa' (vedi
// sopra), quindi non ha mai avuto un conducente associato: eliminarla
// riguarda solo il passeggero che l'ha richiesta e non tocca lo storico
// di nessun altro utente.
router.delete('/:id', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `DELETE FROM corse
       WHERE id = $1 AND passeggero_id = $2 AND stato = 'annullata'
       RETURNING id`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({
        errore: 'Corsa non trovata, oppure non è una richiesta annullata'
      });
    }

    res.json({ messaggio: 'Corsa eliminata dallo storico' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CONDUCENTE ARRIVATO DAL PASSEGGERO
// ================================
router.put('/:id/arrivato', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo il conducente può segnalare l\'arrivo' });
  }

  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET conducente_arrivato_il = NOW()
       WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'
             AND conducente_arrivato_il IS NULL
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }

    res.json({
      messaggio: 'Hai segnalato il tuo arrivo al passeggero',
      corsa: risultato.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CASCO CONSEGNATO (conducente, requisito di sicurezza prima di partire)
// ================================
router.put('/:id/casco-consegnato', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo il conducente può segnalare la consegna del casco' });
  }

  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET casco_consegnato_il = NOW()
       WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'
             AND conducente_arrivato_il IS NOT NULL
             AND casco_consegnato_il IS NULL
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({
        errore: 'Corsa non trovata, oppure devi prima segnalare il tuo arrivo'
      });
    }

    res.json({
      messaggio: 'Casco/cuffia igienica consegnati: ora puoi iniziare il passaggio',
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
// Requisito di sicurezza: non si può partire prima di aver consegnato il
// casco/cuffia igienica al passeggero.
router.put('/:id/inizia', verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'in_corso', iniziata_il = NOW()
       WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'
             AND casco_consegnato_il IS NOT NULL
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({
        errore: 'Corsa non trovata, oppure devi prima consegnare il casco al passeggero'
      });
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
// Senza mappa/GPS non conosciamo i km in anticipo: è il conducente a
// dichiarare i km realmente percorsi a fine corsa, e solo a quel punto
// viene calcolato il rimborso.
router.put('/:id/completa', verificaToken, async (req, res) => {
  const kmPercorsi = parseFloat(req.body.km_percorsi);
  if (isNaN(kmPercorsi) || kmPercorsi <= 0) {
    return res.status(400).json({ errore: 'Indica i km realmente percorsi (numero maggiore di zero)' });
  }

  // Il passeggero paga €1/km con un minimo di €4 a corsa; il conducente
  // riceve il 70% di quanto viene realmente pagato (minimo incluso),
  // il restante 30% resta all'app.
  const prezzoPasseggero = Math.max(kmPercorsi * TARIFFA_PASSEGGERO_PER_KM, MINIMO_PASSEGGERO);
  const rimborsoCalcolato = Math.round(prezzoPasseggero * 100) / 100;
  const rimborsoConducente = Math.round((rimborsoCalcolato * (1 - COMMISSIONE_APP)) * 100) / 100;
  const commissioneApp = Math.round((rimborsoCalcolato - rimborsoConducente) * 100) / 100;

  try {
    const risultato = await pool.query(
      `UPDATE corse
       SET stato = 'completata', completata_il = NOW(),
           distanza_km = $3,
           rimborso_calcolato = $4,
           rimborso_finale = $4,
           rimborso_conducente = $5,
           commissione_app = $6
       WHERE id = $1 AND conducente_id = $2 AND stato = 'in_corso'
       RETURNING *`,
      [req.params.id, req.utente.id, kmPercorsi, rimborsoCalcolato, rimborsoConducente, commissioneApp]
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
// RECENSISCI IL CONDUCENTE (passeggero, dopo una corsa completata)
// ================================
router.post('/:id/recensisci', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'passeggero') {
    return res.status(403).json({ errore: 'Solo il passeggero può recensire il conducente' });
  }

  const voto = parseInt(req.body.voto, 10);
  if (isNaN(voto) || voto < 1 || voto > 5) {
    return res.status(400).json({ errore: 'Il voto deve essere un numero da 1 a 5' });
  }

  try {
    const corsa = await pool.query(
      `SELECT * FROM corse WHERE id = $1 AND passeggero_id = $2`,
      [req.params.id, req.utente.id]
    );

    if (corsa.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }

    const c = corsa.rows[0];

    if (c.stato !== 'completata') {
      return res.status(400).json({ errore: 'Puoi recensire solo una corsa completata' });
    }
    if (!c.conducente_id) {
      return res.status(400).json({ errore: 'Questa corsa non ha un conducente associato' });
    }
    if (c.valutazione_conducente !== null) {
      return res.status(400).json({ errore: 'Hai già recensito questa corsa' });
    }

    await pool.query(
      `UPDATE corse SET valutazione_conducente = $1 WHERE id = $2`,
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
// AGGIORNA POSIZIONE CONDUCENTE
// ================================
router.put('/posizione', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti' });
  }

  const { latitudine, longitudine, disponibile } = req.body;

  // latitudine/longitudine sono opzionali (l'app non ha ancora una mappa/GPS
  // e per ora invia solo il flag di disponibilità): con COALESCE aggiorniamo
  // solo i campi effettivamente inviati, senza cancellare dati precedenti
  // né inviare "undefined" al database.
  try {
    await pool.query(
      `UPDATE conducenti
       SET latitudine = COALESCE($1, latitudine),
           longitudine = COALESCE($2, longitudine),
           disponibile = COALESCE($3, disponibile)
       WHERE user_id = $4`,
      [latitudine ?? null, longitudine ?? null, disponibile ?? null, req.utente.id]
    );

    res.json({ messaggio: 'Posizione aggiornata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
