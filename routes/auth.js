const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');

// ================================
// REGISTRAZIONE PASSEGGERO
// ================================
router.post('/registra/passeggero', async (req, res) => {
  const { nome, cognome, email, password, telefono } = req.body;

  if (!nome || !cognome || !email || !password || !telefono) {
    return res.status(400).json({ errore: 'Tutti i campi sono obbligatori' });
  }

  try {
    // Controlla se email esiste già
    const esistente = await pool.query(
      'SELECT id FROM users WHERE email = $1', [email]
    );
    if (esistente.rows.length > 0) {
      return res.status(400).json({ errore: 'Email già registrata' });
    }

    // Cripta la password
    const passwordHash = await bcrypt.hash(password, 12);

    // Crea utente
    const risultato = await pool.query(
      `INSERT INTO users (nome, cognome, email, password, telefono, ruolo)
       VALUES ($1, $2, $3, $4, $5, 'passeggero')
       RETURNING id, nome, cognome, email, ruolo`,
      [nome, cognome, email, passwordHash, telefono]
    );

    const utente = risultato.rows[0];

    // Genera token JWT
    const token = jwt.sign(
      { id: utente.id, email: utente.email, ruolo: utente.ruolo },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      messaggio: 'Registrazione completata!',
      token,
      utente
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// REGISTRAZIONE CONDUCENTE
// ================================
router.post('/registra/conducente', async (req, res) => {
  const {
    nome, cognome, email, password, telefono,
    numero_patente, tipo_patente, targa_moto,
    marca_moto, modello_moto, iban, tipo_servizio, cilindrata, tipo_veicolo,
    accetta_regole_ingaggio
  } = req.body;

  // Tipo di veicolo: scooter (default, comportamento di sempre), bici o
  // minicar. La bici non ha una targa, quindi per lei non la richiediamo;
  // per scooter e minicar (veicoli veri e propri) resta obbligatoria.
  const tipiVeicoloValidi = ['scooter', 'bici', 'minicar'];
  const tipoVeicoloFinale = tipiVeicoloValidi.includes(tipo_veicolo)
    ? tipo_veicolo
    : 'scooter';

  if (!nome || !cognome || !email || !password || !telefono ||
      !numero_patente || !tipo_patente || !iban ||
      (tipoVeicoloFinale !== 'bici' && !targa_moto)) {
    return res.status(400).json({ errore: 'Tutti i campi sono obbligatori' });
  }

  // La schermata "Prima di iniziare con Moto Pass" (requisiti + Regole
  // d'ingaggio) deve essere accettata per intero prima di registrarsi come
  // conducente: la richiediamo anche qui, non solo lato app, così non è
  // possibile aggirarla chiamando direttamente l'API.
  if (accetta_regole_ingaggio !== true) {
    return res.status(400).json({
      errore: 'Devi accettare la checklist "Prima di iniziare con Moto Pass" per registrarti come conducente'
    });
  }

  // Il tipo di servizio è opzionale: se non specificato (o non valido) il
  // conducente viene registrato per entrambi i servizi. La bici però non
  // può mai trasportare persone: qualunque cosa arrivi dal client, per lei
  // forziamo "solo pacchi" anche qui lato server, non solo in app.
  const tipiServizioValidi = ['passeggeri', 'pacchi', 'entrambi'];
  const tipoServizioFinale = tipoVeicoloFinale === 'bici'
    ? 'pacchi'
    : (tipiServizioValidi.includes(tipo_servizio) ? tipo_servizio : 'entrambi');

  // Cilindrata dello scooter, per fasce: se non specificata (o non valida)
  // usiamo una fascia intermedia di default.
  const cilindrateValide = ['fino_50', '51_125', '126_300', 'oltre_300'];
  const cilindrataFinale = cilindrateValide.includes(cilindrata)
    ? cilindrata
    : '51_125';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Controlla se email esiste già
    const esistente = await client.query(
      'SELECT id FROM users WHERE email = $1', [email]
    );
    if (esistente.rows.length > 0) {
      return res.status(400).json({ errore: 'Email già registrata' });
    }

    // Cripta la password
    const passwordHash = await bcrypt.hash(password, 12);

    // Crea utente
    const utente = await client.query(
      `INSERT INTO users (nome, cognome, email, password, telefono, ruolo)
       VALUES ($1, $2, $3, $4, $5, 'conducente')
       RETURNING id, nome, cognome, email, ruolo`,
      [nome, cognome, email, passwordHash, telefono]
    );

    // Crea profilo conducente. regole_ingaggio_accettate_il registra data e
    // ora dell'accettazione della checklist come prova verificabile, non
    // solo un controllo lato app.
    await client.query(
      `INSERT INTO conducenti
       (user_id, numero_patente, tipo_patente, targa_moto, marca_moto, modello_moto, iban, tipo_servizio, cilindrata, tipo_veicolo, regole_ingaggio_accettate_il)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [utente.rows[0].id, numero_patente, tipo_patente,
       targa_moto || null, marca_moto, modello_moto, iban, tipoServizioFinale, cilindrataFinale, tipoVeicoloFinale]
    );

    await client.query('COMMIT');

    // Genera token JWT
    const token = jwt.sign(
      { id: utente.rows[0].id, email, ruolo: 'conducente' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      messaggio: 'Registrazione conducente completata! In attesa di verifica.',
      token,
      utente: {
        ...utente.rows[0],
        tipo_servizio: tipoServizioFinale,
        cilindrata: cilindrataFinale,
        tipo_veicolo: tipoVeicoloFinale
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  } finally {
    client.release();
  }
});

// ================================
// LOGIN (uguale per tutti)
// ================================
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ errore: 'Email e password obbligatorie' });
  }

  try {
    const risultato = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND attivo = true', [email]
    );

    if (risultato.rows.length === 0) {
      return res.status(401).json({ errore: 'Credenziali non valide' });
    }

    const utente = risultato.rows[0];

    // Verifica password
    const passwordValida = await bcrypt.compare(password, utente.password);
    if (!passwordValida) {
      return res.status(401).json({ errore: 'Credenziali non valide' });
    }

    // Genera token JWT
    const token = jwt.sign(
      { id: utente.id, email: utente.email, ruolo: utente.ruolo },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      messaggio: 'Login effettuato!',
      token,
      utente: {
        id: utente.id,
        nome: utente.nome,
        cognome: utente.cognome,
        email: utente.email,
        ruolo: utente.ruolo,
        foto_profilo: utente.foto_profilo
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// AGGIORNA TIPO DI SERVIZIO (conducente)
// ================================
// A differenza della cilindrata/targa, il tipo di servizio può cambiare in
// qualunque momento dalla home: il conducente decide se vuole ricevere
// passaggi persone, piccole consegne, o entrambi.
router.put('/tipo-servizio', require('../middleware/auth').verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono impostare il tipo di servizio' });
  }

  const tipiServizioValidi = ['passeggeri', 'pacchi', 'entrambi'];
  const { tipo_servizio } = req.body;

  if (!tipiServizioValidi.includes(tipo_servizio)) {
    return res.status(400).json({ errore: 'Tipo di servizio non valido' });
  }

  try {
    // La bici non può mai offrire passaggi persone: se chi ha una bici
    // prova a impostare "passeggeri" o "entrambi" (es. app non aggiornata),
    // lo blocchiamo qui, non solo in app.
    const conducente = await pool.query(
      `SELECT tipo_veicolo FROM conducenti WHERE user_id = $1`,
      [req.utente.id]
    );
    if (conducente.rows[0]?.tipo_veicolo === 'bici' && tipo_servizio !== 'pacchi') {
      return res.status(400).json({
        errore: 'Con una bici puoi offrire solo consegne di piccoli pacchi, non passaggi persone'
      });
    }

    await pool.query(
      `UPDATE conducenti SET tipo_servizio = $1 WHERE user_id = $2`,
      [tipo_servizio, req.utente.id]
    );
    res.json({ messaggio: 'Tipo di servizio aggiornato', tipo_servizio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// PROFILO UTENTE
// ================================
router.get('/profilo', require('../middleware/auth').verificaToken, async (req, res) => {
  try {
    // Se una sospensione precedente è scaduta, la puliamo prima di
    // restituire il profilo, così l'app mostra sempre lo stato reale.
    if (req.utente.ruolo === 'conducente') {
      await require('../utils/recensioni').conducenteSospeso(req.utente.id);
    }

    const risultato = await pool.query(
      `SELECT u.id, u.nome, u.cognome, u.email, u.telefono, u.ruolo, u.foto_profilo,
              c.numero_patente, c.targa_moto, c.marca_moto, c.modello_moto,
              c.tipo_servizio, c.cilindrata, c.tipo_veicolo, c.disponibile, c.valutazione_media, c.totale_corse, c.verificato,
              c.pallini_rossi, c.sospeso_fino, c.regole_ingaggio_accettate_il,
              c.avatar_id, c.patente_verificata, c.assicurazione_verificata,
              c.casco_passeggero_disponibile, c.cuffia_igienica_disponibile
       FROM users u
       LEFT JOIN conducenti c ON u.id = c.user_id
       WHERE u.id = $1`,
      [req.utente.id]
    );

    if (risultato.rows.length === 0) {
      return res.status(404).json({ errore: 'Utente non trovato' });
    }

    res.json(risultato.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

// ================================
// SCEGLI AVATAR (conducente)
// ================================
// Niente foto reali per i conducenti: ognuno sceglie un avatar a fumetto
// tra un set fisso, definito anche lato app in avatar_moto_pass.dart.
// Teniamo l'elenco valido anche qui, così non si può salvare un id
// qualsiasi chiamando l'API direttamente.
const AVATAR_VALIDI = Array.from({ length: 12 }, (_, i) => `avatar_${i + 1}`);

router.put('/conducente/avatar', require('../middleware/auth').verificaToken, async (req, res) => {
  if (req.utente.ruolo !== 'conducente') {
    return res.status(403).json({ errore: 'Solo i conducenti possono scegliere un avatar' });
  }

  const { avatar_id } = req.body;
  if (!AVATAR_VALIDI.includes(avatar_id)) {
    return res.status(400).json({ errore: 'Avatar non valido' });
  }

  try {
    await pool.query(
      `UPDATE conducenti SET avatar_id = $1 WHERE user_id = $2`,
      [avatar_id, req.utente.id]
    );
    res.json({ messaggio: 'Avatar aggiornato', avatar_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: 'Errore del server' });
  }
});

module.exports = router;
