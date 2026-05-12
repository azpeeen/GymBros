'use strict';
/**
 * Seed de exercícios — ExerciseDB V1 pública → MySQL + Cloudinary
 * Uso: node scripts/seed-exercisedb.js
 * Pare o servidor antes de rodar para não exceder max_user_connections.
 */
require('dotenv').config();

const mysql      = require('mysql2/promise');
const cloudinary = require('cloudinary').v2;
const https      = require('https');
const http       = require('http');

// ── Cloudinary ────────────────────────────────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Constantes ────────────────────────────────────────────────────────────────
const EXERCISEDB_BASE = 'https://exercisedb.p.rapidapi.com/exercises';
const BATCH_SIZE     = 10;
const CLOUDINARY_FOLDER = 'gymbros/exercises';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Faz um GET HTTP/HTTPS e retorna um Buffer com o corpo da resposta.
 * Segue redirects automaticamente (até 5 saltos).
 */
function fetchBuffer(url, redirectsLeft = 5, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) return reject(new Error('Muitos redirects: ' + url));

        const lib = url.startsWith('https') ? https : http;
        const headers = { 'User-Agent': 'GymBros-Seed/1.0', ...extraHeaders };
        lib.get(url, { headers }, (res) => {
            // Segue redirect
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchBuffer(res.headers.location, redirectsLeft - 1, extraHeaders));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end',  ()  => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Faz GET JSON paginado da ExerciseDB (10 por página) e retorna todos os exercícios.
 */
async function fetchExercises() {
    const rapidHeaders = {
        'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'exercisedb.p.rapidapi.com',
    };

    const PAGE    = 10;
    let offset    = 0;
    let all       = [];
    let firstDone = false;

    console.log('[seed] Buscando exercícios da ExerciseDB (paginado, 10/req)…');

    while (true) {
        const url = `${EXERCISEDB_BASE}?limit=${PAGE}&offset=${offset}`;
        const buf  = await fetchBuffer(url, 5, rapidHeaders);
        const body = JSON.parse(buf.toString('utf8'));

        const page =
            body?.data?.exercises ??
            body?.exercises       ??
            (Array.isArray(body) ? body : null);

        if (!page) throw new Error('Formato de resposta inesperado da ExerciseDB');

        if (!firstDone && page.length > 0) {
            console.log('[seed] Primeiro exercício (campos disponíveis):');
            console.log(JSON.stringify(page[0], null, 2));
            firstDone = true;
        }

        all = all.concat(page);
        console.log(`[seed] offset=${offset} → ${page.length} recebidos (total acumulado: ${all.length})`);

        if (page.length < PAGE) break;
        offset += PAGE;
    }

    console.log(`[seed] Total final: ${all.length} exercícios.`);
    return all;
}

/**
 * Faz upload de um Buffer GIF para o Cloudinary via stream e retorna a URL segura.
 */
function uploadBufferToCloudinary(buffer, publicId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder:         CLOUDINARY_FOLDER,
                public_id:      publicId,
                resource_type:  'image',
                format:         'gif',
                overwrite:      false,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            }
        );
        stream.end(buffer);
    });
}

/**
 * Cria as tabelas no banco caso ainda não existam.
 */
async function createTables(conn) {
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS exercises (
            id                VARCHAR(50)  PRIMARY KEY,
            name              VARCHAR(255) NOT NULL,
            body_part         VARCHAR(100),
            target_muscle     VARCHAR(100),
            equipment_name    VARCHAR(100),
            instructions_json JSON
        )
    `);

    await conn.execute(`
        CREATE TABLE IF NOT EXISTS exercise_media (
            exercise_id        VARCHAR(50)  PRIMARY KEY,
            cloudinary_gif_url VARCHAR(500) NOT NULL,
            synced_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exercise_id) REFERENCES exercises(id)
        )
    `);

    console.log('[seed] Tabelas verificadas/criadas.');
}

/**
 * Processa um único exercício: INSERT no MySQL + download GIF + upload Cloudinary.
 * Retorna true em caso de sucesso, false se houve erro no GIF/Cloudinary (mas o
 * registro na tabela exercises é salvo mesmo assim).
 */
async function processExercise(conn, ex, index, total) {
    const id           = String(ex.id ?? ex.exerciseId ?? '').trim();
    const name         = String(ex.name         ?? '').trim();
    const bodyPart     = String(ex.bodyPart      ?? ex.body_part     ?? '').trim();
    const target       = String(ex.target        ?? ex.target_muscle  ?? '').trim();
    const equipment    = String(ex.equipment     ?? ex.equipment_name ?? '').trim();
    const instructions = ex.instructions ?? [];
    const gifUrl       = String(ex.gifUrl        ?? ex.gif_url       ?? '').trim();

    if (!id || !name) {
        console.warn(`[${index}/${total}] exercício sem id/name — ignorado`);
        return false;
    }

    // ── INSERT exercises (ignora duplicatas) ──────────────────────────────────
    await conn.execute(
        `INSERT IGNORE INTO exercises
            (id, name, body_part, target_muscle, equipment_name, instructions_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, bodyPart, target, equipment, JSON.stringify(instructions)]
    );

    // ── Verifica se já tem mídia salva ────────────────────────────────────────
    const [mediaRows] = await conn.execute(
        'SELECT exercise_id FROM exercise_media WHERE exercise_id = ?', [id]
    );
    if (mediaRows.length > 0) {
        console.log(`[${index}/${total}] ${name} — já sincronizado, pulando GIF`);
        return true;
    }

    // ── Download + Upload GIF ─────────────────────────────────────────────────
    if (!gifUrl) {
        console.warn(`[${index}/${total}] ${name} — sem gifUrl, pulando`);
        return true;
    }

    try {
        const gifBuffer = await fetchBuffer(gifUrl);
        const publicId  = `exercise_${id}`;
        const cdnUrl    = await uploadBufferToCloudinary(gifBuffer, publicId);

        await conn.execute(
            `INSERT INTO exercise_media (exercise_id, cloudinary_gif_url)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE cloudinary_gif_url = VALUES(cloudinary_gif_url), synced_at = CURRENT_TIMESTAMP`,
            [id, cdnUrl]
        );

        console.log(`[${index}/${total}] ${name} — ok`);
        return true;
    } catch (err) {
        console.error(`[${index}/${total}] ${name} — ERRO GIF/Cloudinary: ${err.message}`);
        return false;
    }
}

/**
 * Processa a lista em batches de BATCH_SIZE para não sobrecarregar.
 */
async function processBatches(conn, exercises) {
    const total  = exercises.length;
    let success  = 0;
    let failures = 0;

    for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = exercises.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map((ex, j) => processExercise(conn, ex, i + j + 1, total))
        );

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value === true) success++;
            else failures++;
        }
    }

    return { success, failures };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const conn = await mysql.createConnection({
        host:     process.env.DB_HOST,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port:     Number(process.env.DB_PORT) || 3306,
        timezone: '-03:00',
    });

    console.log('[seed] Conectado ao MySQL — Clever Cloud');

    try {
        await createTables(conn);

        const exercises = await fetchExercises();
        const { success, failures } = await processBatches(conn, exercises);

        console.log(`\n[seed] Concluído. Sucesso: ${success} | Falhas: ${failures} | Total: ${exercises.length}`);
    } finally {
        await conn.end();
        console.log('[seed] Conexão encerrada.');
    }
}

main().catch((err) => {
    console.error('[seed] Erro fatal:', err.message);
    process.exit(1);
});
