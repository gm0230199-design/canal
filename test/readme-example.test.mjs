// =====================================================================
//  D4 — el ejemplo del README tiene que ser la SALIDA REAL del codigo.
//
//  El ejemplo anterior no lo genero nadie: campos de tres instantes
//  distintos del hilo real, incoherente consigo mismo ("tasks: []" mientras
//  su propio "siguiente_paso" decia que habia 2 bloques) y con un
//  "generado_en" redondeado a mano.
//
//  Aqui se fija un hilo de prueba INMUTABLE (test/fixtures/thread-brief.json)
//  y se comprueba que el bloque del README es exactamente lo que devuelve
//  briefIssue() sobre ese hilo. Si el codigo o el ejemplo se desincronizan,
//  el test falla.
// =====================================================================
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { briefIssue, fetchAllComments } from '../src/canal.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..');

const MARCA_INICIO = '<!-- canal-brief-example:start -->';
const MARCA_FIN = '<!-- canal-brief-example:end -->';

async function leerHiloFixture() {
  const bruto = await fs.readFile(path.join(aqui, 'fixtures', 'thread-brief.json'), 'utf8');
  return JSON.parse(bruto);
}

function fetchDeMentira(hilo, llamadas = []) {
  return async (url, opts = {}) => {
    const metodo = (opts.method || 'GET').toUpperCase();
    llamadas.push({ url, metodo, headers: opts.headers || {} });
    return {
      ok: true,
      status: 200,
      json: async () => (metodo === 'GET' ? hilo : {}),
      text: async () => '',
      headers: { get: () => null }
    };
  };
}

test('D4: el ejemplo del README es la salida real de briefIssue', async () => {
  const hilo = await leerHiloFixture();
  const readme = await fs.readFile(path.join(raiz, 'README.md'), 'utf8');

  assert.ok(readme.includes(MARCA_INICIO), `el README debe traer ${MARCA_INICIO}`);
  assert.ok(readme.includes(MARCA_FIN), `el README debe traer ${MARCA_FIN}`);

  const m = readme.match(
    new RegExp(
      `${MARCA_INICIO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*` +
        '```json\\s*([\\s\\S]*?)```\\s*' +
        MARCA_FIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
  );
  assert.ok(m, 'no se encuentra el bloque json del ejemplo entre los marcadores');

  const ejemplo = JSON.parse(m[1]);

  const llamadas = [];
  const real = await briefIssue({
    repo: 'gm0230199-design/canal',
    issue: 1,
    role: 'EJECUTOR',
    fetchImpl: fetchDeMentira(hilo, llamadas),
    env: { GH_TOKEN: 'token-de-prueba' }
  });

  // `generado_en` es una marca de tiempo: cambia en cada ejecucion y no se
  // compara. Todo lo demas tiene que ser IDENTICO.
  delete real.generado_en;
  delete ejemplo.generado_en;

  assert.deepEqual(ejemplo, real, 'el ejemplo del README debe coincidir con la salida real');
  assert.equal(
    llamadas.filter((c) => c.metodo !== 'GET').length,
    0,
    'brief debe ser de solo lectura: ningun POST'
  );
});

test('D5: sin token no se manda la cabecera Authorization', async () => {
  const llamadas = [];
  await fetchAllComments({
    repo: 'gm0230199-design/canal',
    issue: 1,
    token: '',
    fetchImpl: fetchDeMentira([], llamadas)
  });

  assert.equal(llamadas.length, 1);
  assert.equal(
    llamadas[0].headers.Authorization,
    undefined,
    'sin token no se debe mandar Authorization (GitHub responde 401 a "Bearer " vacio)'
  );
  assert.equal(llamadas[0].headers.Accept, 'application/vnd.github+json');
});

test('D5: con token si se manda la cabecera Authorization', async () => {
  const llamadas = [];
  await fetchAllComments({
    repo: 'gm0230199-design/canal',
    issue: 1,
    token: 'secreto123',
    fetchImpl: fetchDeMentira([], llamadas)
  });

  assert.equal(llamadas[0].headers.Authorization, 'Bearer secreto123');
});
