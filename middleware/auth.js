const jwt = require('jsonwebtoken');

const verificaToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      errore: 'Accesso negato. Token mancante.' 
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.utente = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ 
      errore: 'Token non valido o scaduto.' 
    });
  }
};

module.exports = { verificaToken };
