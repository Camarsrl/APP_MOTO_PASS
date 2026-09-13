const { pool } = require('../database');

// ================================
// SISTEMA RECENSIONI E SOSPENSIONE CONDUCENTI
// ================================
// Un voto di 1 o 2 stelle (su 5) conta come recensione negativa e fa
// scattare un "pallino rosso". Superata la soglia, il conducente viene
// sospeso temporaneamente: non può più accettare passaggi o consegne
// finché la sospensione non scade. Valori "ragionevoli" di partenza,
// facili da cambiare qui in un unico punto.
const VOTO_NEGATIVO_MASSIMO = 2;   // 1 o 2 stelle = pallino rosso (una recensione negativa)
const SOGLIA_PALLINI_ROSSI = 5;    // al 5° pallino rosso scatta la sospensione
const GIORNI_SOSPENSIONE = 30;     // durata della sospensione (1 mese)

// Se la sospensione di un conducente è scaduta, la rimuove (i pallini
// rossi sono già stati azzerati quando è scattata la sospensione).
async function pulisciSospensioneScaduta(conducenteUserId) {
  await pool.query(
    `UPDATE conducenti SET sospeso_fino = NULL
     WHERE user_id = $1 AND sospeso_fino IS NOT NULL AND sospeso_fino <= NOW()`,
    [conducenteUserId]
  );
}

// Controlla se un conducente è attualmente sospeso. Da chiamare prima di
// permettergli di accettare un passaggio o una consegna.
async function conducenteSospeso(conducenteUserId) {
  await pulisciSospensioneScaduta(conducenteUserId);
  const risultato = await pool.query(
    `SELECT sospeso_fino FROM conducenti WHERE user_id = $1`,
    [conducenteUserId]
  );
  const sospesoFino = risultato.rows[0]?.sospeso_fino || null;
  return { sospeso: !!sospesoFino, sospesoFino };
}

// Registra un voto (1-5) ricevuto da un conducente: aggiorna la sua media
// (calcolata su tutte le corse + consegne valutate) e, se il voto è
// negativo, aggiunge un pallino rosso, sospendendolo se supera la soglia.
async function registraVotoConducente(conducenteUserId, voto) {
  const media = await pool.query(
    `SELECT AVG(voto)::numeric(3,2) AS media FROM (
       SELECT valutazione_conducente AS voto FROM corse
         WHERE conducente_id = $1 AND valutazione_conducente IS NOT NULL
       UNION ALL
       SELECT valutazione_conducente AS voto FROM consegne
         WHERE conducente_id = $1 AND valutazione_conducente IS NOT NULL
     ) tutte_le_recensioni`,
    [conducenteUserId]
  );
  const nuovaMedia = media.rows[0]?.media ?? voto;

  if (voto > VOTO_NEGATIVO_MASSIMO) {
    await pool.query(
      `UPDATE conducenti SET valutazione_media = $1 WHERE user_id = $2`,
      [nuovaMedia, conducenteUserId]
    );
    return { palliniRossi: null, sospeso: false };
  }

  // Voto negativo: aggiungiamo un pallino rosso.
  const aggiornato = await pool.query(
    `UPDATE conducenti
     SET valutazione_media = $1, pallini_rossi = pallini_rossi + 1
     WHERE user_id = $2
     RETURNING pallini_rossi`,
    [nuovaMedia, conducenteUserId]
  );
  const pallini = aggiornato.rows[0]?.pallini_rossi ?? 1;

  if (pallini >= SOGLIA_PALLINI_ROSSI) {
    // Raggiunta la soglia di pallini rossi: sospensione temporanea di un
    // mese, poi si riparte da 0.
    await pool.query(
      `UPDATE conducenti
       SET sospeso_fino = NOW() + ($2 || ' days')::interval, pallini_rossi = 0
       WHERE user_id = $1`,
      [conducenteUserId, String(GIORNI_SOSPENSIONE)]
    );
    return { palliniRossi: 0, sospeso: true };
  }

  return { palliniRossi: pallini, sospeso: false };
}

module.exports = {
  conducenteSospeso,
  registraVotoConducente,
  VOTO_NEGATIVO_MASSIMO,
  SOGLIA_PALLINI_ROSSI,
  GIORNI_SOSPENSIONE,
};
