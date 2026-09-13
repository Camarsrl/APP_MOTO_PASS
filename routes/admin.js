const express = require('express');
const router = express.Router();
const { pool } = require('../database');

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
              c.targa_moto, c.marca_moto, c.modello_moto, c.numero_patente,
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

module.exports = router;
