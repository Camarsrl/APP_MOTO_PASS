require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { initDatabase } = require('./database');

const app = express();
const server = http.createServer(app);

// Socket.io per aggiornamenti in tempo reale (posizione conducente)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ================================
// MIDDLEWARE
// ================================
app.use(cors());

// ================================
// WEBHOOK STRIPE
// ================================
// Va registrato PRIMA di express.json(), con express.raw(): Stripe firma il
// body "grezzo" della richiesta, quindi se il body fosse già stato
// interpretato come JSON da express.json() la verifica della firma
// (routes/payments.js -> gestisciWebhook) fallirebbe sempre. Per lo stesso
// motivo questa route resta qui, direttamente su app, e NON dentro il
// router di routes/payments.js (che invece è montato più sotto, dopo
// express.json(), per tutte le altre rotte di /api/pagamenti).
const pagamentiRouter = require('./routes/payments');
app.post('/api/pagamenti/webhook', express.raw({ type: 'application/json' }), pagamentiRouter.gestisciWebhook);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================================
// FILE CARICATI (foto consegne)
// ================================
// Su un piano Render a pagamento con un Persistent Disk collegato,
// impostare la variabile d'ambiente UPLOAD_DIR con il percorso di mount
// del disco (es. /data) così le foto restano tra un deploy e l'altro,
// invece di essere cancellate ad ogni riavvio come sul piano gratuito. In
// locale, senza questa variabile, i file finiscono in una cartella
// "uploads" accanto al codice.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(path.join(UPLOAD_DIR, 'consegne'), { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));
// Le routes che gestiscono l'upload leggono da qui dove scrivere.
app.set('uploadDir', UPLOAD_DIR);

// ================================
// ROUTES
// ================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/corse', require('./routes/rides'));
app.use('/api/consegne', require('./routes/consegne'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/pagamenti', pagamentiRouter);

// Route di test
app.get('/', (req, res) => {
  res.json({
    messaggio: '🛵 Moto Pass API attiva!',
    versione: '1.0.0',
    stato: 'online'
  });
});

// ================================
// SOCKET.IO - Aggiornamenti real-time
// ================================
io.on('connection', (socket) => {
  console.log('📱 Utente connesso:', socket.id);

  // Conducente aggiorna la sua posizione
  socket.on('aggiorna_posizione', (data) => {
    // Invia la posizione a tutti i passeggeri nella stessa stanza
    socket.broadcast.emit('posizione_conducente', {
      conducente_id: data.conducente_id,
      lat: data.lat,
      lng: data.lng
    });
  });

  // Passeggero entra in una stanza per seguire la corsa
  socket.on('segui_corsa', (corsa_id) => {
    socket.join(`corsa_${corsa_id}`);
    console.log(`👤 Passeggero segue corsa ${corsa_id}`);
  });

  // Conducente accetta la corsa - notifica il passeggero
  socket.on('corsa_accettata', (data) => {
    io.to(`corsa_${data.corsa_id}`).emit('conducente_in_arrivo', {
      conducente: data.conducente,
      tempo_stimato: data.tempo_stimato
    });
  });

  // Corsa completata
  socket.on('corsa_completata', (data) => {
    io.to(`corsa_${data.corsa_id}`).emit('corsa_terminata', {
      rimborso: data.rimborso
    });
  });

  socket.on('disconnect', () => {
    console.log('📵 Utente disconnesso:', socket.id);
  });
});

// ================================
// AVVIO SERVER
// ================================
const PORT = process.env.PORT || 3000;

const avvia = async () => {
  // Inizializza il database
  await initDatabase();

  server.listen(PORT, () => {
    console.log(`\n🛵 ================================`);
    console.log(`   MOTO PASS BACKEND ATTIVO!`);
    console.log(`   Porta: ${PORT}`);
    console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🛵 ================================\n`);
  });
};

avvia();
