require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================================
// ROUTES
// ================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/corse', require('./routes/rides'));
app.use('/api/pagamenti', require('./routes/payments'));

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
