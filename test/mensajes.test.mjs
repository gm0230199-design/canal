// =====================================================================
//  Los pendientes tienen que distinguir MENSAJES de CABECERAS DE TAREA.
//
//  "task:T-001 claim" no es un mensaje: es un marcador de la maquina. Antes
//  de este cambio, reentrar en el hilo decia "responder 17 comentarios"
//  cuando solo habia 8 mensajes de verdad (9 eran cabeceras).
// =====================================================================
import assert from 'node:assert/strict';
import test from 'node:test';
import { briefIssue } from '../src/canal.mjs';

const C = (id, body, created_at) => ({ id, body, created_at, user: { login: 'x' } });

const HILO = [
  C(1, '[AGENTE] Instruccion 7', '2026-01-01T00:00:00Z'),
  C(2, '[EJECUTOR] reply-to:1\nEntendido', '2026-01-01T00:00:01Z'),
  C(3, '[EJECUTOR] task:T-001\nTitulo', '2026-01-01T00:00:02Z'),
  C(4, '[EJECUTOR] task:T-001 claim', '2026-01-01T00:00:03Z'),
  C(5, '[EJECUTOR] task:T-001 progress\navanzando', '2026-01-01T00:00:04Z'),
  C(6, '[EJECUTOR] reply-to:9\nBloque 5 verificado', '2026-01-01T00:00:05Z')
];

function fetchDeMentira(hilo) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => hilo,
    text: async () => '',
    headers: { get: () => null }
  });
}

async function brief(hilo, role) {
  return briefIssue({
    repo: 'gm0230199-design/canal',
    issue: 1,
    role,
    fetchImpl: fetchDeMentira(hilo),
    env: { GH_TOKEN: 'token-de-prueba' }
  });
}

test('esperando_a_mi_mensajes excluye las cabeceras de tarea', async () => {
  const res = await brief(HILO, 'EJECUTOR');

  // todas las cabeceras y mensajes propios sin respuesta
  assert.deepEqual(res.esperando_a_mi, [2, 3, 4, 5, 6]);
  // solo los mensajes de verdad (sin prefijos "task:")
  assert.deepEqual(res.esperando_a_mi_mensajes, [2, 6]);
});

test('sin_responder_mensajes excluye las cabeceras de tarea', async () => {
  const res = await brief(HILO, 'AGENTE');

  // desde el AGENTE, lo que espera respuesta son los comentarios del
  // EJECUTOR: 2, 3, 4, 5 y 6. De esos, solo 2 y 6 son mensajes.
  assert.deepEqual(res.sin_responder, [2, 3, 4, 5, 6]);
  assert.deepEqual(res.sin_responder_mensajes, [2, 6]);

  // y lo mio propio: el comentario 2 responde al 1, asi que no hay nada
  // mio pendiente
  assert.deepEqual(res.esperando_a_mi, []);
  assert.deepEqual(res.esperando_a_mi_mensajes, []);
});

test('siguiente_paso cuenta mensajes y aparta las cabeceras', async () => {
  const res = await brief(HILO, 'AGENTE');

  // dos mensajes pendientes de verdad (2 y 6) y tres cabeceras aparte
  assert.match(res.siguiente_paso, /Responder 2 mensaje\(s\) pendiente\(s\) del otro rol/);
  assert.match(res.siguiente_paso, /mas 3 cabecera\(s\) de tarea sin responder/);
  assert.doesNotMatch(res.siguiente_paso, /17 comentario/);
});

test('siguiente_paso no inventa pendientes cuando no hay', async () => {
  // el EJECUTOR responde y el AGENTE contesta: no queda nada pendiente
  const limpio = [C(1, '[EJECUTOR] Instruccion', '2026-01-01T00:00:00Z'),
                  C(2, '[AGENTE] reply-to:1\nHecho', '2026-01-01T00:00:01Z')];
  const res = await brief(limpio, 'AGENTE');
  assert.deepEqual(res.sin_responder_mensajes, []);
  assert.match(res.siguiente_paso, /Esperando respuesta del otro rol a 1 mensaje|Hilo sin tareas/);
});
