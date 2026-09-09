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
    marca_moto, modello_moto, iban 
  } = req.body;

  if (!nome || !cognome || !email || !password || !telefono ||
      !numero_patente || !tipo_patente || !targa_moto || !iban) {
    return res.status(400).json({ errore: 'Tutti i campi sono obbligatori' });
  }

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

    // Crea profilo conducente
    await client.query(
      `INSERT INTO conducenti 
       (user_id, numero_patente, tipo_patente, targa_moto, marca_moto, modello_moto, iban)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [utente.rows[0].id, numero_patente, tipo_patente, 
       targa_moto, marca_moto, modello_moto, iban]
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
      utente: utente.rows[0]
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
// PROFILO UTENTE
// ================================
router.get('/profilo', require('../middleware/auth').verificaToken, async (req, res) => {
  try {
    const risultato = await pool.query(
      `SELECT u.id, u.nome, u.cognome, u.email, u.telefono, u.ruolo, u.foto_profilo,
              c.numero_patente, c.targa_moto, c.marca_moto, c.modello_moto,
              c.disponibile, c.valutazione_media, c.totale_corse, c.verificato
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

module.exports = router;
