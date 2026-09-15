const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Crea tutte le tabelle necessarie
const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      -- TABELLA UTENTI (passeggeri e conducenti)
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        telefono VARCHAR(20) NOT NULL,
        ruolo VARCHAR(20) NOT NULL CHECK (ruolo IN ('passeggero', 'conducente')),
        foto_profilo VARCHAR(500),
        stripe_customer_id VARCHAR(255),
        stripe_account_id VARCHAR(255),
        attivo BOOLEAN DEFAULT true,
        creato_il TIMESTAMP DEFAULT NOW()
      );

      -- TABELLA CONDUCENTI (dati aggiuntivi)
      CREATE TABLE IF NOT EXISTS conducenti (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        numero_patente VARCHAR(50) NOT NULL,
        tipo_patente VARCHAR(10) NOT NULL,
        targa_moto VARCHAR(20) NOT NULL,
        marca_moto VARCHAR(100),
        modello_moto VARCHAR(100),
        cilindrata VARCHAR(20) NOT NULL DEFAULT '51_125'
          CHECK (cilindrata IN ('fino_50', '51_125', '126_300', 'oltre_300')),
        foto_patente VARCHAR(500),
        foto_documento VARCHAR(500),
        iban VARCHAR(50),
        tipo_servizio VARCHAR(20) NOT NULL DEFAULT 'entrambi'
          CHECK (tipo_servizio IN ('passeggeri', 'pacchi', 'entrambi')),
        verificato BOOLEAN DEFAULT false,
        disponibile BOOLEAN DEFAULT false,
        latitudine DECIMAL(10, 8),
        longitudine DECIMAL(11, 8),
        valutazione_media DECIMAL(3,2) DEFAULT 5.00,
        totale_corse INTEGER DEFAULT 0,
        pallini_rossi INTEGER NOT NULL DEFAULT 0,
        sospeso_fino TIMESTAMP
      );

      -- TABELLA CORSE
      CREATE TABLE IF NOT EXISTS corse (
        id SERIAL PRIMARY KEY,
        passeggero_id INTEGER REFERENCES users(id),
        conducente_id INTEGER REFERENCES users(id),
        stato VARCHAR(30) DEFAULT 'in_attesa'
          CHECK (stato IN ('in_attesa', 'accettata', 'in_corso', 'completata', 'annullata')),
        partenza_indirizzo TEXT NOT NULL,
        partenza_lat DECIMAL(10, 8),
        partenza_lng DECIMAL(11, 8),
        destinazione_indirizzo TEXT NOT NULL,
        destinazione_lat DECIMAL(10, 8),
        destinazione_lng DECIMAL(11, 8),
        distanza_km DECIMAL(8, 2),
        cilindrata_preferita VARCHAR(20)
          CHECK (cilindrata_preferita IS NULL OR cilindrata_preferita IN ('fino_50', '51_125', '126_300', 'oltre_300')),
        rimborso_calcolato DECIMAL(8, 2),
        rimborso_finale DECIMAL(8, 2),
        rimborso_conducente DECIMAL(8, 2),
        commissione_app DECIMAL(8, 2),
        stripe_payment_intent VARCHAR(255),
        valutazione_passeggero INTEGER CHECK (valutazione_passeggero BETWEEN 1 AND 5),
        valutazione_conducente INTEGER CHECK (valutazione_conducente BETWEEN 1 AND 5),
        accettata_il TIMESTAMP,
        conducente_arrivato_il TIMESTAMP,
        casco_consegnato_il TIMESTAMP,
        iniziata_il TIMESTAMP,
        completata_il TIMESTAMP,
        creata_il TIMESTAMP DEFAULT NOW()
      );

      -- TABELLA CONSEGNE (piccoli oggetti/pacchi)
      CREATE TABLE IF NOT EXISTS consegne (
        id SERIAL PRIMARY KEY,
        mittente_id INTEGER REFERENCES users(id),
        conducente_id INTEGER REFERENCES users(id),
        stato VARCHAR(30) DEFAULT 'richiesta'
          CHECK (stato IN ('richiesta', 'accettata', 'ritirata', 'consegnata', 'annullata')),
        ritiro_indirizzo TEXT NOT NULL,
        ritiro_lat DECIMAL(10, 8),
        ritiro_lng DECIMAL(11, 8),
        consegna_indirizzo TEXT NOT NULL,
        consegna_lat DECIMAL(10, 8),
        consegna_lng DECIMAL(11, 8),
        descrizione_oggetto TEXT NOT NULL,
        categoria VARCHAR(20) NOT NULL DEFAULT 'altro'
          CHECK (categoria IN ('fiori', 'documenti', 'piccolo_pacco', 'altro')),
        foto_url VARCHAR(500),
        peso_kg DECIMAL(5, 2) NOT NULL,
        dimensione_cm DECIMAL(5, 1) NOT NULL,
        distanza_km DECIMAL(8, 2),
        destinatario_nome VARCHAR(200) NOT NULL,
        destinatario_telefono VARCHAR(20) NOT NULL,
        note TEXT,
        rimborso_calcolato DECIMAL(8, 2),
        rimborso_finale DECIMAL(8, 2),
        rimborso_conducente DECIMAL(8, 2),
        commissione_app DECIMAL(8, 2),
        valutazione_conducente INTEGER CHECK (valutazione_conducente BETWEEN 1 AND 5),
        creata_il TIMESTAMP DEFAULT NOW(),
        accettata_il TIMESTAMP,
        ritirata_il TIMESTAMP,
        consegnata_il TIMESTAMP
      );

      -- TABELLA PAGAMENTI
      CREATE TABLE IF NOT EXISTS pagamenti (
        id SERIAL PRIMARY KEY,
        corsa_id INTEGER REFERENCES corse(id),
        passeggero_id INTEGER REFERENCES users(id),
        conducente_id INTEGER REFERENCES users(id),
        importo DECIMAL(8, 2) NOT NULL,
        stato VARCHAR(30) DEFAULT 'pending'
          CHECK (stato IN ('pending', 'completato', 'fallito', 'rimborsato')),
        stripe_payment_id VARCHAR(255),
        stripe_transfer_id VARCHAR(255),
        creato_il TIMESTAMP DEFAULT NOW()
      );

      -- TABELLA NOTIFICHE
      CREATE TABLE IF NOT EXISTS notifiche (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        titolo VARCHAR(255) NOT NULL,
        messaggio TEXT NOT NULL,
        letta BOOLEAN DEFAULT false,
        creata_il TIMESTAMP DEFAULT NOW()
      );

      -- Se la tabella "conducenti" esisteva già da prima (creata senza
      -- tipo_servizio), aggiungiamo la colonna senza toccare i dati esistenti.
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS tipo_servizio VARCHAR(20) NOT NULL DEFAULT 'entrambi';

      -- Idem per la cilindrata dello scooter del conducente.
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS cilindrata VARCHAR(20) NOT NULL DEFAULT '51_125';

      -- La tabella "corse" esisteva già con partenza/destinazione lat-lng
      -- obbligatorie: l'app non ha ancora una mappa, quindi i passeggeri
      -- inseriscono solo l'indirizzo testuale. Rendiamo le coordinate
      -- opzionali senza perdere i dati già presenti.
      ALTER TABLE corse ALTER COLUMN partenza_lat DROP NOT NULL;
      ALTER TABLE corse ALTER COLUMN partenza_lng DROP NOT NULL;
      ALTER TABLE corse ALTER COLUMN destinazione_lat DROP NOT NULL;
      ALTER TABLE corse ALTER COLUMN destinazione_lng DROP NOT NULL;

      -- Preferenza di cilindrata del passeggero in fase di richiesta corsa.
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS cilindrata_preferita VARCHAR(20);

      -- Sistema recensioni e sospensione conducenti: pallini rossi per
      -- recensioni negative (1-2 stelle) e data fine sospensione temporanea.
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS pallini_rossi INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS sospeso_fino TIMESTAMP;

      -- Anche le consegne pacchi possono essere valutate dal mittente.
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS valutazione_conducente INTEGER
          CHECK (valutazione_conducente BETWEEN 1 AND 5);

      -- Ciclo vita completo del passaggio: senza mappa/GPS il passeggero non
      -- indica più una distanza stimata. Il rimborso viene calcolato a fine
      -- corsa sui km realmente percorsi (dichiarati dal conducente), e il
      -- viaggio passa per tappe intermedie utili anche per la sicurezza
      -- (arrivo del conducente, consegna del casco) prima di poter partire.
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS accettata_il TIMESTAMP;
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS conducente_arrivato_il TIMESTAMP;
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS casco_consegnato_il TIMESTAMP;

      -- Le consegne diventano un servizio a sé, distinto dai passaggi
      -- persone: il mittente sceglie una categoria semplice (fiori,
      -- documenti, piccolo pacco, altro) per far capire subito al
      -- conducente cosa gli viene chiesto di trasportare.
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS categoria VARCHAR(20) NOT NULL DEFAULT 'altro';

      -- Foto opzionale dell'oggetto da consegnare, caricata dal mittente
      -- dopo aver creato la richiesta. Salviamo solo il percorso relativo
      -- (servito da server.js tramite /uploads su un disco persistente).
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS foto_url VARCHAR(500);

      -- Commissione dell'app: il conducente/consegnatario riceve sempre la
      -- tariffa piena per km (rimborso_conducente), mentre chi richiede il
      -- servizio paga un importo maggiorato del 30% (rimborso_calcolato).
      -- commissione_app è la differenza tra i due, trattenuta dalla
      -- piattaforma. Vale sia per i passaggi che per le consegne.
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS rimborso_conducente DECIMAL(8, 2);
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS commissione_app DECIMAL(8, 2);
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS rimborso_conducente DECIMAL(8, 2);
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS commissione_app DECIMAL(8, 2);

      -- Data/ora in cui il conducente ha accettato la checklist "Prima di
      -- iniziare con Moto Pass" (requisiti + Regole d'ingaggio), mostrata in
      -- fase di registrazione. Serve come prova verificabile dell'accettazione,
      -- non solo un controllo lato app.
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS regole_ingaggio_accettate_il TIMESTAMP;

      -- Niente foto profilo reale per i conducenti, per tutelare la privacy:
      -- ognuno sceglie un avatar a fumetto tra un set predefinito (vedi
      -- lib/widgets/avatar_moto_pass.dart nell'app), mostrato al passeggero
      -- al posto di una fotografia. 'avatar_1' come default finché non ne
      -- sceglie uno.
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS avatar_id VARCHAR(20) NOT NULL DEFAULT 'avatar_1';

      -- Bollini di verifica separati dal generico "verificato" (che resta
      -- l'identità): patente, assicurazione e dotazione di sicurezza per il
      -- passeggero. Non sono selezionabili dal conducente: partono tutti a
      -- false e li attiva solo chi controlla i documenti, dalla schermata
      -- di amministrazione (routes/admin.js).
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS patente_verificata BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS assicurazione_verificata BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS casco_passeggero_disponibile BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS cuffia_igienica_disponibile BOOLEAN NOT NULL DEFAULT false;

      -- ================================
      -- PAGAMENTI STRIPE
      -- ================================
      -- Il passeggero salva una carta (Stripe SetupIntent): non tocchiamo mai
      -- il numero della carta, solo l'id del metodo di pagamento restituito
      -- da Stripe e pochi dati non sensibili per mostrarlo in app (marca +
      -- ultime 4 cifre). users.stripe_customer_id esiste già dalla creazione
      -- della tabella.
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(255);
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS metodo_pagamento_marca VARCHAR(20);
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS metodo_pagamento_ultime4 VARCHAR(4);

      -- Il conducente collega un conto Stripe Connect Express (onboarding
      -- ospitato da Stripe) per ricevere gli accrediti automaticamente.
      -- users.stripe_account_id esiste già dalla creazione della tabella;
      -- stripe_connect_pronto è una cache aggiornata da routes/payments.js
      -- (sia dopo un controllo diretto sia dal webhook 'account.updated')
      -- così l'app non deve interrogare Stripe ad ogni apertura schermata.
      ALTER TABLE conducenti
        ADD COLUMN IF NOT EXISTS stripe_connect_pronto BOOLEAN NOT NULL DEFAULT false;

      -- Esito dell'addebito al passeggero, mostrato nel riepilogo del
      -- passaggio/consegna. Il pagamento viene tentato solo a fine corsa: un
      -- fallimento (es. carta assente o rifiutata) non blocca mai il
      -- completamento del passaggio/consegna.
      ALTER TABLE corse
        ADD COLUMN IF NOT EXISTS pagamento_stato VARCHAR(20) NOT NULL DEFAULT 'non_richiesto'
          CHECK (pagamento_stato IN ('non_richiesto', 'riuscito', 'fallito'));
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS pagamento_stato VARCHAR(20) NOT NULL DEFAULT 'non_richiesto'
          CHECK (pagamento_stato IN ('non_richiesto', 'riuscito', 'fallito'));
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS stripe_payment_intent VARCHAR(255);

      -- La tabella "pagamenti" esisteva già pensata solo per le corse:
      -- aggiungiamo il collegamento anche alle consegne e un tipo per
      -- distinguerle, senza toccare le righe già presenti.
      ALTER TABLE pagamenti
        ADD COLUMN IF NOT EXISTS consegna_id INTEGER REFERENCES consegne(id);
      ALTER TABLE pagamenti
        ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'corsa'
          CHECK (tipo IN ('corsa', 'consegna'));

      -- ================================
      -- SMARRIMENTO PACCHI (consegne)
      -- ================================
      -- Il mittente può segnalare che un pacco non è arrivato: raccogliamo
      -- solo poche informazioni con un modulo guidato (nessuna IA), e la
      -- decisione se rimborsare resta sempre a chi gestisce l'assistenza
      -- (schermata di amministrazione), mai automatica.
      CREATE TABLE IF NOT EXISTS segnalazioni_smarrimento (
        id SERIAL PRIMARY KEY,
        consegna_id INTEGER NOT NULL REFERENCES consegne(id),
        mittente_id INTEGER NOT NULL REFERENCES users(id),
        contattato_conducente BOOLEAN NOT NULL DEFAULT false,
        dettagli TEXT NOT NULL,
        stato VARCHAR(30) NOT NULL DEFAULT 'aperta'
          CHECK (stato IN ('aperta', 'risolta_rimborsata', 'risolta_senza_rimborso')),
        note_risoluzione TEXT,
        creata_il TIMESTAMP DEFAULT NOW(),
        risolta_il TIMESTAMP
      );

      -- Segna un pagamento "in contestazione" quando è aperta una
      -- segnalazione di smarrimento sulla consegna collegata: è un
      -- promemoria visibile in amministrazione, non un blocco automatico
      -- dell'accredito (Stripe accredita il conducente in tempi brevi e non
      -- offre un modo semplice per sospenderlo in anticipo). In caso di
      -- rimborso, l'importo viene comunque recuperato anche dal conducente
      -- tramite il rimborso Stripe con storno del trasferimento.
      ALTER TABLE pagamenti
        ADD COLUMN IF NOT EXISTS contestato BOOLEAN NOT NULL DEFAULT false;

      -- Chat tra mittente e conducente, solo mentre una segnalazione di
      -- smarrimento è aperta: serve a chiarire subito il problema, non è
      -- una messaggistica generale dell'app. Niente notifiche push: l'app
      -- controlla i nuovi messaggi mentre la schermata è aperta.
      CREATE TABLE IF NOT EXISTS messaggi_smarrimento (
        id SERIAL PRIMARY KEY,
        segnalazione_id INTEGER NOT NULL REFERENCES segnalazioni_smarrimento(id),
        autore_id INTEGER NOT NULL REFERENCES users(id),
        testo TEXT NOT NULL,
        creato_il TIMESTAMP DEFAULT NOW()
      );

      -- Foto obbligatoria che il conducente scatta al pacco nel momento del
      -- ritiro (prova archiviata nell'app, diversa dalla foto facoltativa
      -- che il mittente può allegare quando crea la richiesta).
      ALTER TABLE consegne
        ADD COLUMN IF NOT EXISTS foto_ritiro_url VARCHAR(500);
    `);
    console.log('✅ Database inizializzato correttamente');
  } catch (err) {
    console.error('❌ Errore inizializzazione database:', err);
  } finally {
    client.release();
  }
};

module.exports = { pool, initDatabase };
