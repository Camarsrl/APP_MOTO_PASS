# 🛵 Moto Pass - Backend API

Backend completo per l'app Moto Pass - ride sharing in scooter.

## 🚀 Deploy su Render

### Step 1 - Carica su GitHub
```bash
git init
git add .
git commit -m "Moto Pass backend v1.0"
git remote add origin https://github.com/TUO_USERNAME/motopass-backend.git
git push -u origin main
```

### Step 2 - Crea il servizio su Render
1. Vai su render.com
2. Clicca "New Web Service"
3. Collega il tuo repository GitHub
4. Imposta:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node

### Step 3 - Crea il Database su Render
1. Su Render clicca "New PostgreSQL"
2. Copia la "Internal Database URL"
3. Aggiungila come variabile ambiente

### Step 4 - Variabili Ambiente su Render
Aggiungi queste variabili in "Environment":
```
DATABASE_URL=postgresql://... (da Render)
JWT_SECRET=scegli_una_parola_segreta_lunga
STRIPE_SECRET_KEY=sk_test_... (da Stripe)
NODE_ENV=production
```

## 📡 API Endpoints

### Autenticazione
| Metodo | URL | Descrizione |
|--------|-----|-------------|
| POST | /api/auth/registra/passeggero | Registra passeggero |
| POST | /api/auth/registra/conducente | Registra conducente |
| POST | /api/auth/login | Login |
| GET  | /api/auth/profilo | Profilo utente |

### Corse
| Metodo | URL | Descrizione |
|--------|-----|-------------|
| GET | /api/corse/conducenti-vicini | Cerca conducenti |
| POST | /api/corse/richiedi | Richiedi corsa |
| PUT | /api/corse/:id/accetta | Accetta corsa |
| PUT | /api/corse/:id/inizia | Inizia corsa |
| PUT | /api/corse/:id/completa | Completa corsa |
| GET | /api/corse/storico | Storico corse |
| PUT | /api/corse/posizione | Aggiorna posizione |

### Pagamenti
| Metodo | URL | Descrizione |
|--------|-----|-------------|
| POST | /api/pagamenti/crea/:corsa_id | Crea pagamento |
| POST | /api/pagamenti/conferma/:corsa_id | Conferma pagamento |
| GET  | /api/pagamenti/storico | Storico pagamenti |

## 💶 Calcolo Rimborso
- **€0.25 per km** (benzina + spese)
- Automatico in base alla distanza

## 🔒 Sicurezza
- Password criptate con bcrypt
- Token JWT con scadenza 30 giorni
- SSL su tutte le connessioni
- Database PostgreSQL su Render
