const { pool } = require('../database');

// ================================
// ASSISTENTE IA per le segnalazioni di smarrimento
// ================================
// Risponde in automatico nella chat tra mittente e conducente quando è
// aperta una segnalazione (pacco non arrivato, danneggiato, ritardo,
// malinteso). Raccoglie i dettagli mancanti e propone i prossimi passi per
// i casi semplici, ma non decide né promette mai un rimborso: quello resta
// sempre compito di una persona (vedi routes/admin.js). Per i casi seri
// (incidenti con feriti, sospette frodi, rimborsi importanti, comportamento
// minaccioso) smette di rispondere nel merito e segnala che serve un
// operatore umano.
//
// Richiede la variabile d'ambiente ANTHROPIC_API_KEY su Render (mai in
// chat, va impostata direttamente lì, come già fatto per Stripe). Se manca,
// l'assistente resta semplicemente disattivato: la chat continua a
// funzionare normalmente tra le persone, senza IA.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODELLO_DEFAULT = 'claude-3-5-haiku-20241022';

const PROMPT_SISTEMA = `Sei l'Assistente Moto Pass, il supporto automatico di primo livello per le segnalazioni sui pacchi consegnati con l'app Moto Pass (passaggi e piccole consegne in scooter/bici/minicar, modello carpooling con rimborso spese, non un corriere commerciale).

Quando si apre una segnalazione (pacco non arrivato, danneggiato, in ritardo, malinteso con il conducente):
- Fai domande brevi e concrete per raccogliere i dettagli mancanti (cosa è successo, quando, se il mittente ha già contattato il conducente, se ci sono foto).
- Per i casi semplici (piccolo ritardo, malinteso che si chiarisce in chat, informazioni mancanti) rassicura la persona e suggerisci i prossimi passi, ma non puoi decidere né promettere un rimborso: quella decisione spetta sempre a una persona del team Moto Pass.
- Se la situazione riguarda un incidente con feriti, un sospetto di frode o furto, un importo di rimborso importante, un comportamento minaccioso o violento, o qualunque cosa che ti sembri seria o che non sai gestire, smetti di indagare nel merito: rispondi con gentilezza dicendo che stai passando la segnalazione a un operatore del team, che la contatterà al più presto.
- Tono cordiale, diretto, in italiano, massimo 4-5 righe per messaggio: è una chat da smartphone, non un'email.

Rispondi SEMPRE e SOLO con un oggetto JSON valido, senza nessun testo fuori dal JSON e senza blocchi \`\`\`, con questa forma esatta:
{"messaggio": "<il messaggio da mostrare in chat>", "richiede_operatore": <true o false>, "riepilogo": "<una riga che riassume la situazione per chi lavora in amministrazione>"}`;

// Genera (se possibile) la prossima risposta dell'assistente per una
// segnalazione e la salva in chat. Non lancia mai errori verso il
// chiamante: un problema con l'IA non deve mai bloccare l'invio del
// messaggio della persona né la creazione della segnalazione.
async function generaRispostaIA({ segnalazioneId, consegnaId }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY non impostata: assistente IA disattivato');
    return null;
  }

  try {
    const segnalazioneRes = await pool.query(
      `SELECT * FROM segnalazioni_smarrimento WHERE id = $1`,
      [segnalazioneId]
    );
    if (segnalazioneRes.rows.length === 0) return null;
    const s = segnalazioneRes.rows[0];

    // Se una persona ha già preso in carico la segnalazione, l'IA non
    // interviene più: evitiamo che il bot parli sopra un operatore reale.
    if (s.richiede_operatore) return null;

    const consegnaRes = await pool.query(
      `SELECT descrizione_oggetto, categoria, ritiro_indirizzo, consegna_indirizzo, rimborso_calcolato
       FROM consegne WHERE id = $1`,
      [consegnaId]
    );
    const c = consegnaRes.rows[0] || {};

    const storicoRes = await pool.query(
      `SELECT autore_tipo, testo FROM messaggi_smarrimento
       WHERE segnalazione_id = $1 ORDER BY creato_il ASC`,
      [segnalazioneId]
    );

    const contesto = `Dettagli della consegna:
- Oggetto: ${c.descrizione_oggetto || 'n/d'} (categoria: ${c.categoria || 'n/d'})
- Ritiro: ${c.ritiro_indirizzo || 'n/d'}
- Consegna: ${c.consegna_indirizzo || 'n/d'}
- Eventuale rimborso calcolato dal sistema: ${c.rimborso_calcolato != null ? c.rimborso_calcolato + ' euro' : 'n/d'}
- Il mittente ha già contattato il conducente: ${s.contattato_conducente ? 'sì' : 'no'}
- Dettagli iniziali della segnalazione: ${s.dettagli || 'n/d'}`;

    const messaggiClaude = [
      { role: 'user', content: contesto },
      ...storicoRes.rows.map((m) => ({
        role: m.autore_tipo === 'ia' ? 'assistant' : 'user',
        content: m.testo
      }))
    ];

    // Anthropic richiede che i messaggi alternino user/assistant: se per
    // qualche motivo ci sono due messaggi 'user' di fila (es. mittente e
    // conducente scrivono entrambi prima che l'IA risponda), li uniamo.
    const messaggiUniti = [];
    for (const m of messaggiClaude) {
      const ultimo = messaggiUniti[messaggiUniti.length - 1];
      if (ultimo && ultimo.role === m.role) {
        ultimo.content += '\n' + m.content;
      } else {
        messaggiUniti.push({ ...m });
      }
    }

    const rispostaHttp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || MODELLO_DEFAULT,
        max_tokens: 500,
        system: PROMPT_SISTEMA,
        messages: messaggiUniti
      })
    });

    if (!rispostaHttp.ok) {
      console.error('Errore chiamata Anthropic:', rispostaHttp.status, await rispostaHttp.text());
      return null;
    }

    const dati = await rispostaHttp.json();
    const testoGrezzo = dati.content?.[0]?.text || '';

    let parsed;
    try {
      const pulito = testoGrezzo.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(pulito);
    } catch (e) {
      console.error('Risposta IA non in formato JSON valido:', testoGrezzo);
      parsed = {
        messaggio: testoGrezzo.trim() || 'Grazie per il messaggio: un operatore del team lo verificherà al più presto.',
        richiede_operatore: true,
        riepilogo: null
      };
    }

    const messaggioIA = (parsed.messaggio || '').toString().trim();
    if (!messaggioIA) return null;

    const inserito = await pool.query(
      `INSERT INTO messaggi_smarrimento (segnalazione_id, autore_id, autore_tipo, testo)
       VALUES ($1, NULL, 'ia', $2)
       RETURNING id, testo, creato_il, autore_id, autore_tipo`,
      [segnalazioneId, messaggioIA]
    );

    if (parsed.richiede_operatore === true) {
      await pool.query(
        `UPDATE segnalazioni_smarrimento SET richiede_operatore = true, riepilogo_ia = $1 WHERE id = $2`,
        [(parsed.riepilogo || '').toString().trim() || null, segnalazioneId]
      );
    } else if (parsed.riepilogo) {
      await pool.query(
        `UPDATE segnalazioni_smarrimento SET riepilogo_ia = $1 WHERE id = $2`,
        [parsed.riepilogo.toString().trim(), segnalazioneId]
      );
    }

    return inserito.rows[0];
  } catch (err) {
    console.error('Errore assistente IA:', err.message);
    return null;
  }
}

module.exports = { generaRispostaIA };
