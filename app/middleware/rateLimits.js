'use strict';
const rateLimit = require('express-rate-limit');

const limiterGeral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' },
});

const limiterLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { erro: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

const limiterUpload = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Limite de uploads atingido. Tente novamente em 1 hora.' },
});

module.exports = { limiterGeral, limiterLogin, limiterUpload };
