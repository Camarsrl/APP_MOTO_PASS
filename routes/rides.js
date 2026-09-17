const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');
const { conducenteSospeso, registraVotoConducente } = require('../utils/recensioni');
const { eseguiAddebito } = require('./payments');
const { generaRispostaIA } = require('../utils/assistenteIA');

// Categorie di segnalazione utilizzabili per un passaggio ("smarrimento" e
// "danneggiato" riguardano solo un pacco: non hanno senso qui, sono per le
// consegne — vedi routes/consegne.js).
const CATEGORIE_SEGNALAZIONE_CORSA = ['non_arrivato', 'incidente', 'pagamento'];

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
    cilindrata_preferita, veicolo_preferito
  } = req.body;

  if (!partenza_indirizzo || !destinazione_indirizzo) {
    return res.status(400).json({ errore: 'Indirizzo di partenza e destinazione obbligatori' });
  }

  // La preferenza di cilindrata è facoltativa: "nessuna preferenza" se assente o non valida.
  const cilindrataFinale = CILINDRATE_VALIDE.includes(cilindrata_preferita)
    ? cilindrata_preferita
    : null;

  // Idem per la preferenza di veicolo (scooter o minicar, le uniche due che
  // danno passaggi): solo informativa, non filtra chi può accettare.
  const veicoliPreferitiValidi = ['scooter', 'minicar'];
  const veicoloPreferitoFinale = veicoliPreferitiValidi.includes(veicolo_preferito)
    ? veicolo_preferito
    : null;

  try {
    const risultato = await pool.query(
      `INSERT INTO corse (
        passeggero_id, stato,
        partenza_indirizzo, partenza_lat, partenza_lng,
        destinazione_indirizzo, destinazione_lat, destinazione_lng,
        cilindrata_preferita, veicolo_preferito
      ) VALUES ($1, 'in_attesa', $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        req.utente.id,
        partenza_indirizzo, partenza_lat || null, partenza_lng || null,
        destinazione_indirizzo, destinazione_lat || null, destinazione_lng || null,
        cilindrataFinale, veicoloPreferitoFinale
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
    // Bici e conducenti impostati su "solo pacchi" non fanno passaggi:
    // lista vuota, non un errore, perché è una condizione normale (in app
    // questa schermata non è comunque raggiungibile in quel caso).
    const profilo = await pool.query(
      `SELECT tipo_veicolo, tipo_servizio FROM conducenti WHERE user_id = $1`,
      [req.utente.id]
    );
    const p = profilo.rows[0];
    if (!p || p.tipo_veicolo === 'bici' || p.tipo_servizio === 'pacchi') {
      return res.json({ corse: [] });
    }

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
              co.nome AS nome_conducente, co.cognome AS cognome_conducente, co.foto_profilo AS foto_conducente,
              -- Ultima segnalazione per questo passaggio (se esiste), così
              -- l'app può mostrarne lo stato senza una seconda chiamata.
              s.stato AS segnalazione_stato,
              s.note_risoluzione AS segnalazione_note
       FROM corse c
       LEFT JOIN users p ON c.passeggero_id = p.id
       LEFT JOIN users co ON c.conducente_id = co.id
       LEFT JOIN LATERAL (
         SELECT stato, note_risoluzione FROM segnalazioni_smarrimento
         WHERE corsa_id = c.id
         ORDER BY creata_il DESC
         LIMIT 1
       ) s ON true
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
              cd.targa_moto, cd.marca_moto, cd.modello_moto, cd.cilindrata, cd.tipo_veicolo,
              cd.valutazione_media AS valutazione_conducente_media,
              cd.avatar_id AS avatar_conducente,
              cd.verificato AS conducente_verificato,
              cd.patente_verificata, cd.assicurazione_verificata,
              cd.casco_passeggero_disponibile, cd.cuffia_igienica_disponibile,
              -- Recensioni positive/negative (non più una media a stelle):
              -- la soglia "> 2" è la stessa di VOTO_NEGATIVO_MASSIMO in
              -- utils/recensioni.js, quindi resta coerente con i pallini
              -- rossi che portano alla sospensione del conducente.
              (SELECT COUNT(*) FILTER (WHERE voto > 2) FROM (
                 SELECT valutazione_conducente AS voto FROM corse
                   WHERE conducente_id = c.conducente_id AND valutazione_conducente IS NOT NULL
                 UNION ALL
                 SELECT valutazione_conducente AS voto FROM consegne
                   WHERE conducente_id = c.conducente_id AND valutazione_conducente IS NOT NULL
               ) recensioni)::int AS recensioni_positive,
              (SELECT COUNT(*) FILTER (WHERE voto <= 2) FROM (
                 SELECT valutazione_conducente AS voto FROM corse
                   WHERE conducente_id = c.conducente_id AND valutazione_conducente IS NOT NULL
                 UNION ALL
                 SELECT valutazione_conducente AS voto FROM consegne
                   WHERE conducente_id = c.conducente_id AND valutazione_conducente IS NOT NULL
               ) recensioni)::int AS recensioni_negative
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
    // Stessa regola di GET /disponibili, controllata di nuovo qui: una bici
    // (o un profilo impostato su "solo pacchi") non può accettare un
    // passaggio persone, anche chiamando questa API direttamente.
    const profilo = await pool.query(
      `SELECT tipo_veicolo, tipo_servizio FROM conducenti WHERE user_id = $1`,
      [req.utente.id]
    );
    const p = profilo.rows[0];
    if (!p || p.tipo_veicolo === 'bici' || p.tipo_servizio === 'pacchi') {
      return res.status(403).json({
        errore: 'Il tuo profilo non è abilitato ai passaggi persone'
      });
    }

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

    const corsa = risultato.rows[0];

    // L'addebito avviene solo ora, a corsa conclusa: un eventuale fallimento
    // (carta assente/rifiutata) non deve annullare il passaggio, già
    // regolarmente svolto. L'esito viene solo registrato e mostrato in app.
    const esito = await eseguiAddebito({
      tipo: 'corsa',
      riferimentoId: corsa.id,
      passeggeroId: corsa.passeggero_id,
      conducenteId: corsa.conducente_id,
      importoPasseggero: rimborsoCalcolato,
      importoConducente: rimborsoConducente,
      commissioneApp
    });

    const aggiornata = await pool.query(
      `UPDATE corse SET pagamento_stato = $1, stripe_payment_intent = $2 WHERE id = $3 RETURNING *`,
      [esito.riuscito ? 'riuscito' : 'fallito', esito.paymentIntentId || null, corsa.id]
    );

    res.json({
      messaggio: esito.riuscito
        ? 'Corsa completata! Il pagamento è andato a buon fine.'
        : `Corsa completata, ma il pagamento non è riuscito (${esito.motivoErrore}).`,
      corsa: aggiornata.rows[0]
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

// ================================
// SEGNALA UN PROBLEMA SU UN PASSAGGIO (passeggero o conducente)
// ================================
// Stesso meccanismo delle segnalazioni sulle consegne (stessa tabella,
// stessa chat, stesso assistente IA): qui copre "il conducente non si è
// presentato", un incidente durante il passaggio o un problema con
// l'addebito. La decisione se rimborsare resta comunque sempre a chi
// gestisce l'assistenza (vedi routes/admin.js), mai automatica.
router.post('/:id/segnala-problema', verificaToken, async (req, res) => {
  const dettagli = req.body.dettagli?.toString().trim();
  const categoria = req.body.categoria?.toString().trim();

  if (!dettagli) {
    return res.status(400).json({ errore: 'Descrivi cosa è successo' });
  }
  if (!CATEGORIE_SEGNALAZIONE_CORSA.includes(categoria)) {
    return res.status(400).json({ errore: 'Categoria non valida' });
  }

  try {
    const corsa = await pool.query(`SELECT * FROM corse WHERE id = $1`, [req.params.id]);
    if (corsa.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }
    const c = corsa.rows[0];
    if (c.passeggero_id !== req.utente.id && c.conducente_id !== req.utente.id) {
      return res.status(403).json({ errore: 'Non hai accesso a questa corsa' });
    }
    // "accettata" è inclusa per permettere di segnalare subito che il
    // conducente non si è presentato, o un incidente, senza dover aspettare
    // che il passaggio sia terminato.
    if (!['accettata', 'in_corso', 'completata'].includes(c.stato)) {
      return res.status(400).json({
        errore: 'Puoi segnalare un problema solo dopo che un conducente ha accettato la corsa'
      });
    }

    const giaAperta = await pool.query(
      `SELECT id FROM segnalazioni_smarrimento WHERE corsa_id = $1 AND stato = 'aperta'`,
      [req.params.id]
    );
    if (giaAperta.rows.length > 0) {
      return res.status(400).json({ errore: 'Hai già una segnalazione aperta per questo passaggio' });
    }

    const segnalazioneCreata = await pool.query(
      `INSERT INTO segnalazioni_smarrimento (corsa_id, mittente_id, dettagli, categoria)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [req.params.id, req.utente.id, dettagli, categoria]
    );
    const segnalazioneId = segnalazioneCreata.rows[0].id;

    // Il testo scritto nel modulo diventa il primo messaggio della chat,
    // così la conversazione con l'assistente IA parte da lì.
    await pool.query(
      `INSERT INTO messaggi_smarrimento (segnalazione_id, autore_id, autore_tipo, testo)
       VALUES ($1, $2, 'utente', $3)`,
      [segnalazioneId, req.utente.id, dettagli]
    );

    // Promemoria visibile in amministrazione, come per le consegne: non
    // blocca da solo l'addebito già avviato su Stripe, ma segnala il
    // pagamento come "in contestazione".
    await pool.query(
      `UPDATE pagamenti SET contestato = true WHERE corsa_id = $1`,
      [req.params.id]
    );

    // L'assistente IA risponde per primo raccogliendo altri dettagli
    // (best-effort: se fallisce o manca la chiave API, la segnalazione resta
    // comunque creata correttamente). Per un incidente, generaRispostaIA
    // forza comunque il passaggio a un operatore fin dal primo messaggio.
    await generaRispostaIA({ segnalazioneId });

    res.status(201).json({ messaggio: 'Segnalazione inviata. Ti risponderemo al più presto.', segnalazione_id: segnalazioneId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CHAT SULLA SEGNALAZIONE DI UN PASSAGGIO (passeggero e conducente)
// ================================
// Esiste solo mentre una segnalazione è aperta: serve a chiarire subito il
// problema tra le due persone coinvolte, non è una messaggistica generale
// dell'app. Nessuna notifica push: l'app controlla i nuovi messaggi mentre
// questa schermata è aperta.
router.get('/:id/segnalazione/messaggi', verificaToken, async (req, res) => {
  try {
    const corsa = await pool.query(`SELECT * FROM corse WHERE id = $1`, [req.params.id]);
    if (corsa.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }
    const c = corsa.rows[0];
    if (c.passeggero_id !== req.utente.id && c.conducente_id !== req.utente.id) {
      return res.status(403).json({ errore: 'Non hai accesso a questa corsa' });
    }

    const segnalazione = await pool.query(
      `SELECT id FROM segnalazioni_smarrimento
       WHERE corsa_id = $1 AND stato = 'aperta'
       ORDER BY creata_il DESC LIMIT 1`,
      [req.params.id]
    );
    if (segnalazione.rows.length === 0) {
      return res.json({ segnalazione_aperta: false, messaggi: [] });
    }

    // LEFT JOIN perché i messaggi dell'assistente IA non hanno un utente
    // collegato (autore_id è NULL per quelli).
    const messaggi = await pool.query(
      `SELECT m.id, m.testo, m.creato_il, m.autore_id, m.autore_tipo, u.nome, u.cognome
       FROM messaggi_smarrimento m
       LEFT JOIN users u ON m.autore_id = u.id
       WHERE m.segnalazione_id = $1
       ORDER BY m.creato_il ASC`,
      [segnalazione.rows[0].id]
    );

    res.json({
      segnalazione_aperta: true,
      segnalazione_id: segnalazione.rows[0].id,
      messaggi: messaggi.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

router.post('/:id/segnalazione/messaggi', verificaToken, async (req, res) => {
  const testo = req.body.testo?.toString().trim();
  if (!testo) {
    return res.status(400).json({ errore: 'Scrivi un messaggio' });
  }

  try {
    const corsa = await pool.query(`SELECT * FROM corse WHERE id = $1`, [req.params.id]);
    if (corsa.rows.length === 0) {
      return res.status(404).json({ errore: 'Corsa non trovata' });
    }
    const c = corsa.rows[0];
    if (c.passeggero_id !== req.utente.id && c.conducente_id !== req.utente.id) {
      return res.status(403).json({ errore: 'Non hai accesso a questa corsa' });
    }

    const segnalazione = await pool.query(
      `SELECT id FROM segnalazioni_smarrimento
       WHERE corsa_id = $1 AND stato = 'aperta'
       ORDER BY creata_il DESC LIMIT 1`,
      [req.params.id]
    );
    if (segnalazione.rows.length === 0) {
      return res.status(400).json({ errore: 'Nessuna segnalazione aperta per questo passaggio' });
    }

    const risultato = await pool.query(
      `INSERT INTO messaggi_smarrimento (segnalazione_id, autore_id, autore_tipo, testo)
       VALUES ($1, $2, 'utente', $3)
       RETURNING id, testo, creato_il, autore_id, autore_tipo`,
      [segnalazione.rows[0].id, req.utente.id, testo]
    );

    // L'assistente IA risponde subito dopo (best-effort: se non risponde, il
    // messaggio della persona è comunque salvato correttamente).
    await generaRispostaIA({ segnalazioneId: segnalazione.rows[0].id });

    res.status(201).json({ messaggio: risultato.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
