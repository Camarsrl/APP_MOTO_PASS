const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { pool } = require('../database');
const { verificaToken } = require('../middleware/auth');
const { conducenteSospeso, registraVotoConducente } = require('../utils/recensioni');
const { eseguiAddebito } = require('./payments');

// Foto opzionale dell'oggetto da consegnare: scritta dove server.js indica
// (app.set('uploadDir', ...)), che su Render punta al Persistent Disk in
// produzione. Limite 5 MB, solo immagini.
const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(req.app.get('uploadDir'), 'consegne'));
    },
    filename: (req, file, cb) => {
      const estensione = path.extname(file.originalname) || '.jpg';
      cb(null, `consegna_${req.params.id}_${Date.now()}${estensione}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Puoi caricare solo immagini'));
    }
    cb(null, true);
  }
});

// ================================
// LIMITI E TARIFFE CONSEGNA PACCHI
// ================================
// Valori "ragionevoli" di partenza: facili da cambiare qui in un unico punto
// non appena i responsabili confermano i limiti definitivi.
const PESO_MASSIMO_KG = 5;        // peso massimo del pacco
const DIMENSIONE_MASSIMA_CM = 40; // lato più lungo del pacco, in cm
const SUPPLEMENTO_FISSO = 1.0;    // € fissi per ogni consegna (netti per il conducente)
const COSTO_PER_KM = 0.2;         // € per km, oltre al supplemento fisso (netti per il conducente)

// L'app trattiene una commissione anche sulle consegne: il conducente
// riceve sempre supplemento + km netti, il mittente paga un importo
// maggiorato per coprire la commissione.
const COMMISSIONE_APP = 0.30; // 30%

// Categorie semplici che aiutano il conducente a capire a colpo d'occhio
// cosa gli viene chiesto di trasportare.
const CATEGORIE_VALIDE = ['fiori', 'documenti', 'piccolo_pacco', 'altro'];

// ================================
// RICHIEDI UNA CONSEGNA (mittente)
// ================================
// Qualunque utente registrato (passeggero o conducente) può inviare un
// piccolo pacco o dei fiori: non è richiesto un ruolo specifico.
router.post('/richiedi', verificaToken, async (req, res) => {
  const {
    ritiro_indirizzo, ritiro_lat, ritiro_lng,
    consegna_indirizzo, consegna_lat, consegna_lng,
    descrizione_oggetto, categoria, peso_kg, dimensione_cm,
    distanza_km, destinatario_nome, destinatario_telefono, note
  } = req.body;

  const categoriaFinale = CATEGORIE_VALIDE.includes(categoria) ? categoria : 'altro';

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
    let rimborsoConducente = null;
    let rimborso = null; // quanto paga il mittente (include la commissione app)
    let commissioneApp = null;
    if (distanza) {
      rimborsoConducente = Math.round((SUPPLEMENTO_FISSO + distanza * COSTO_PER_KM) * 100) / 100;
      rimborso = Math.round((rimborsoConducente / (1 - COMMISSIONE_APP)) * 100) / 100;
      commissioneApp = Math.round((rimborso - rimborsoConducente) * 100) / 100;
    }

    const risultato = await pool.query(
      `INSERT INTO consegne (
        mittente_id, stato,
        ritiro_indirizzo, ritiro_lat, ritiro_lng,
        consegna_indirizzo, consegna_lat, consegna_lng,
        descrizione_oggetto, categoria, peso_kg, dimensione_cm, distanza_km,
        destinatario_nome, destinatario_telefono, note,
        rimborso_calcolato, rimborso_conducente, commissione_app
      ) VALUES ($1, 'richiesta', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        req.utente.id,
        ritiro_indirizzo, ritiro_lat || null, ritiro_lng || null,
        consegna_indirizzo, consegna_lat || null, consegna_lng || null,
        descrizione_oggetto, categoriaFinale, peso, dimensione, distanza,
        destinatario_nome, destinatario_telefono, note || null,
        rimborso, rimborsoConducente, commissioneApp
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
// CARICA FOTO DELLA CONSEGNA (mittente, opzionale)
// ================================
router.post('/:id/foto', verificaToken, async (req, res) => {
  // Verifichiamo che la consegna esista e sia del mittente PRIMA di
  // scrivere qualunque file su disco.
  try {
    const consegna = await pool.query(
      `SELECT id FROM consegne WHERE id = $1 AND mittente_id = $2`,
      [req.params.id, req.utente.id]
    );
    if (consegna.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ errore: 'Errore del server' });
  }

  uploadFoto.single('foto')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ errore: err.message || 'Errore nel caricamento della foto' });
    }
    if (!req.file) {
      return res.status(400).json({ errore: 'Nessuna foto ricevuta' });
    }

    try {
      const fotoUrl = `/uploads/consegne/${req.file.filename}`;
      const risultato = await pool.query(
        `UPDATE consegne SET foto_url = $1 WHERE id = $2 RETURNING *`,
        [fotoUrl, req.params.id]
      );
      res.json({ messaggio: 'Foto caricata', consegna: risultato.rows[0] });
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ errore: 'Errore del server' });
    }
  });
});

// ================================
// CARICA FOTO DEL RITIRO (conducente, obbligatoria per confermare il ritiro)
// ================================
// Diversa dalla foto facoltativa del mittente qui sopra: questa la scatta
// il conducente sul posto, al momento di prendere in carico il pacco, ed è
// la prova che resta archiviata nell'app. Va caricata mentre la consegna è
// ancora 'accettata' (prima di confermare il ritiro, vedi PUT /:id/ritirata
// qui sotto, che ora richiede che questa foto esista già).
const uploadFotoRitiro = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(req.app.get('uploadDir'), 'consegne'));
    },
    filename: (req, file, cb) => {
      const estensione = path.extname(file.originalname) || '.jpg';
      cb(null, `ritiro_${req.params.id}_${Date.now()}${estensione}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Puoi caricare solo immagini'));
    }
    cb(null, true);
  }
});

router.post('/:id/foto-ritiro', verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo il conducente può caricare la foto del ritiro' });
  }

  // Verifichiamo che la consegna sia assegnata a questo conducente e non
  // ancora ritirata PRIMA di scrivere qualunque file su disco.
  try {
    const consegna = await pool.query(
      `SELECT id FROM consegne WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'`,
      [req.params.id, req.utente.id]
    );
    if (consegna.rows.length === 0) {
      return res.status(404).json({
        errore: 'Consegna non trovata, non assegnata a te, oppure già ritirata'
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ errore: 'Errore del server' });
  }

  uploadFotoRitiro.single('foto')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ errore: err.message || 'Errore nel caricamento della foto' });
    }
    if (!req.file) {
      return res.status(400).json({ errore: 'Nessuna foto ricevuta' });
    }

    try {
      const fotoUrl = `/uploads/consegne/${req.file.filename}`;
      const risultato = await pool.query(
        `UPDATE consegne SET foto_ritiro_url = $1 WHERE id = $2 RETURNING *`,
        [fotoUrl, req.params.id]
      );
      res.json({ messaggio: 'Foto del ritiro caricata', consegna: risultato.rows[0] });
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ errore: 'Errore del server' });
    }
  });
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
    // La foto del ritiro (vedi POST /:id/foto-ritiro qui sopra) è
    // obbligatoria: senza, la richiesta non trova righe da aggiornare e
    // torniamo un errore che lo spiega chiaramente all'utente.
    const risultato = await pool.query(
      `UPDATE consegne
       SET stato = 'ritirata', ritirata_il = NOW()
       WHERE id = $1 AND conducente_id = $2 AND stato = 'accettata'
             AND foto_ritiro_url IS NOT NULL
       RETURNING *`,
      [req.params.id, req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({
        errore: 'Consegna non trovata, oppure devi prima fare una foto del pacco al ritiro'
      });
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

    const consegna = risultato.rows[0];

    // Come per i passaggi: l'addebito avviene solo ora, a consegna
    // conclusa. Un eventuale fallimento non annulla la consegna già svolta,
    // viene solo registrato e mostrato in app.
    let esito = { riuscito: false, motivoErrore: 'Importo non calcolato (distanza non indicata alla richiesta)' };
    if (consegna.rimborso_calcolato != null && consegna.rimborso_conducente != null) {
      esito = await eseguiAddebito({
        tipo: 'consegna',
        riferimentoId: consegna.id,
        passeggeroId: consegna.mittente_id,
        conducenteId: consegna.conducente_id,
        importoPasseggero: parseFloat(consegna.rimborso_calcolato),
        importoConducente: parseFloat(consegna.rimborso_conducente),
        commissioneApp: parseFloat(consegna.commissione_app || 0)
      });
    }

    const aggiornata = await pool.query(
      `UPDATE consegne SET pagamento_stato = $1, stripe_payment_intent = $2 WHERE id = $3 RETURNING *`,
      [esito.riuscito ? 'riuscito' : 'fallito', esito.paymentIntentId || null, consegna.id]
    );

    res.json({
      messaggio: esito.riuscito
        ? 'Consegna completata! Il pagamento è andato a buon fine.'
        : `Consegna completata, ma il pagamento non è riuscito (${esito.motivoErrore}).`,
      consegna: aggiornata.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// SEGNALA PACCO SMARRITO (mittente)
// ================================
// Modulo guidato con poche domande fisse (nessuna IA): raccoglie la
// segnalazione, ma la decisione se rimborsare resta sempre a chi gestisce
// l'assistenza (vedi routes/admin.js), mai automatica.
router.post('/:id/segnala-smarrimento', verificaToken, async (req, res) => {
  const contattatoConducente = req.body.contattato_conducente === true;
  const dettagli = req.body.dettagli?.toString().trim();

  if (!dettagli) {
    return res.status(400).json({ errore: 'Descrivi cosa è successo' });
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
    if (!['ritirata', 'consegnata'].includes(c.stato)) {
      return res.status(400).json({
        errore: 'Puoi segnalare uno smarrimento solo dopo che il pacco è stato ritirato'
      });
    }

    const giaAperta = await pool.query(
      `SELECT id FROM segnalazioni_smarrimento WHERE consegna_id = $1 AND stato = 'aperta'`,
      [req.params.id]
    );
    if (giaAperta.rows.length > 0) {
      return res.status(400).json({ errore: 'Hai già una segnalazione aperta per questa consegna' });
    }

    await pool.query(
      `INSERT INTO segnalazioni_smarrimento (consegna_id, mittente_id, contattato_conducente, dettagli)
       VALUES ($1, $2, $3, $4)`,
      [req.params.id, req.utente.id, contattatoConducente, dettagli]
    );

    // Promemoria visibile in amministrazione: non blocca da solo l'accredito
    // già avviato su Stripe, ma segnala il pagamento come "in contestazione".
    await pool.query(
      `UPDATE pagamenti SET contestato = true WHERE consegna_id = $1`,
      [req.params.id]
    );

    res.status(201).json({ messaggio: 'Segnalazione inviata. Ti risponderemo al più presto.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// CHAT SULLA SEGNALAZIONE DI SMARRIMENTO (mittente e conducente)
// ================================
// Esiste solo mentre una segnalazione è aperta: serve a chiarire subito il
// problema tra le due persone coinvolte, non è una messaggistica generale
// dell'app. Nessuna notifica push: l'app controlla i nuovi messaggi
// mentre questa schermata è aperta.
router.get('/:id/segnalazione/messaggi', verificaToken, async (req, res) => {
  try {
    const consegna = await pool.query(`SELECT * FROM consegne WHERE id = $1`, [req.params.id]);
    if (consegna.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata' });
    }
    const c = consegna.rows[0];
    if (c.mittente_id !== req.utente.id && c.conducente_id !== req.utente.id) {
      return res.status(403).json({ errore: 'Non hai accesso a questa consegna' });
    }

    const segnalazione = await pool.query(
      `SELECT id FROM segnalazioni_smarrimento
       WHERE consegna_id = $1 AND stato = 'aperta'
       ORDER BY creata_il DESC LIMIT 1`,
      [req.params.id]
    );
    if (segnalazione.rows.length === 0) {
      return res.json({ segnalazione_aperta: false, messaggi: [] });
    }

    const messaggi = await pool.query(
      `SELECT m.id, m.testo, m.creato_il, m.autore_id, u.nome, u.cognome
       FROM messaggi_smarrimento m
       JOIN users u ON m.autore_id = u.id
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
    const consegna = await pool.query(`SELECT * FROM consegne WHERE id = $1`, [req.params.id]);
    if (consegna.rows.length === 0) {
      return res.status(404).json({ errore: 'Consegna non trovata' });
    }
    const c = consegna.rows[0];
    if (c.mittente_id !== req.utente.id && c.conducente_id !== req.utente.id) {
      return res.status(403).json({ errore: 'Non hai accesso a questa consegna' });
    }

    const segnalazione = await pool.query(
      `SELECT id FROM segnalazioni_smarrimento
       WHERE consegna_id = $1 AND stato = 'aperta'
       ORDER BY creata_il DESC LIMIT 1`,
      [req.params.id]
    );
    if (segnalazione.rows.length === 0) {
      return res.status(400).json({ errore: 'Nessuna segnalazione aperta per questa consegna' });
    }

    const risultato = await pool.query(
      `INSERT INTO messaggi_smarrimento (segnalazione_id, autore_id, testo)
       VALUES ($1, $2, $3)
       RETURNING id, testo, creato_il, autore_id`,
      [segnalazione.rows[0].id, req.utente.id, testo]
    );

    res.status(201).json({ messaggio: risultato.rows[0] });
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
              co.nome AS nome_conducente, co.cognome AS cognome_conducente,
              cd.avatar_id AS avatar_conducente,
              cd.valutazione_media AS valutazione_conducente_media,
              cd.verificato AS conducente_verificato,
              cd.patente_verificata, cd.assicurazione_verificata,
              cd.casco_passeggero_disponibile, cd.cuffia_igienica_disponibile,
              -- Ultima segnalazione di smarrimento per questa consegna (se
              -- esiste), così l'app può mostrare lo stato senza una seconda
              -- chiamata.
              s.stato AS segnalazione_smarrimento_stato,
              s.note_risoluzione AS segnalazione_smarrimento_note
       FROM consegne c
       JOIN users m ON c.mittente_id = m.id
       LEFT JOIN users co ON c.conducente_id = co.id
       LEFT JOIN conducenti cd ON c.conducente_id = cd.user_id
       LEFT JOIN LATERAL (
         SELECT stato, note_risoluzione FROM segnalazioni_smarrimento
         WHERE consegna_id = c.id
         ORDER BY creata_il DESC
         LIMIT 1
       ) s ON true
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
