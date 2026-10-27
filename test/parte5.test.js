'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { criarXlsx, serialExcel, crc32 } = require('../src/xlsx');
const { avaliarQualidade, textoQualidade } = require('../src/qualidade');
const { normalizarTodos, criarCliente } = require('../src/dss');
const { criarMemoria } = require('../src/historico');
const { criarServidor } = require('../src/server');

const H = 36e5;
const AGORA = Date.parse('2026-10-27T15:00:00Z');
const f = (h) => new Date(AGORA + h * H).toISOString().replace('T', ' ').slice(0, 19);
const reg = (navio, viagem, terminal, datas, armador = 'MSC') => ({ navio, nro_viagem: viagem, armador, terminal, timezone: 'UTC', ...datas });

/** Lê os arquivos de um zip (só o necessário para conferir o .xlsx). */
function lerZip(buf) {
  const arquivos = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const tam = buf.readUInt32LE(p + 18);
    const nomeTam = buf.readUInt16LE(p + 26);
    const nome = buf.slice(p + 30, p + 30 + nomeTam).toString();
    const dados = zlib.inflateRawSync(buf.slice(p + 30 + nomeTam, p + 30 + nomeTam + tam)).toString();
    assert.equal(crc32(Buffer.from(dados)), buf.readUInt32LE(p + 14), `CRC de ${nome}`);
    arquivos[nome] = dados;
    p += 30 + nomeTam + tam;
  }
  return arquivos;
}

test('xlsx: zip válido, datas no horário de Brasília, texto escapado', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(serialExcel('2026-10-27T15:00:00Z'), Date.UTC(2026, 9, 27, 12) / 864e5 + 25569, '15:00 UTC = 12:00 em Brasília');
  const buf = criarXlsx([
    { nome: 'Navios', colunas: [{ titulo: 'Navio' }, { titulo: 'Deadline', tipo: 'data' }, { titulo: 'Horas', tipo: 'numero' }], linhas: [['A & <B>', '2026-10-27T15:00:00Z', 20], ['C', null, null]] },
    { nome: 'Mudanças (7 dias)', colunas: [{ titulo: 'Quando', tipo: 'data' }], linhas: [] },
  ]);
  const z = lerZip(buf);
  assert.ok(z['[Content_Types].xml'] && z['xl/workbook.xml'] && z['xl/styles.xml'] && z['xl/worksheets/sheet2.xml']);
  assert.match(z['xl/workbook.xml'], /name="Mudanças \(7 dias\)"/);
  const s1 = z['xl/worksheets/sheet1.xml'];
  assert.match(s1, /A &amp; &lt;B&gt;/);
  assert.match(s1, /<c r="B2" s="2"><v>46322\.5<\/v><\/c>/);
  assert.match(s1, /<c r="C2" s="3"><v>20<\/v><\/c>/);
  assert.match(s1, /<autoFilter ref="A1:C3"\/>/);
  assert.match(s1, /state="frozen"/);
});

const BRUTOS = [
  reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(-100), data_atracacao: f(-90), data_prev_saida: f(10), data_prev_abertura_gate: f(-150), data_abertura_gate: f(-150), data_deadline: f(-80), data_lib_reefer: f(-150) }),
  reg('COPIAPO', 'MM643R', 'btp', { data_prev_chegada: f(-60), data_prev_saida: f(30), data_prev_abertura_gate: f(-100), data_deadline: f(-40) }, 'HLC'),
  reg('NOVO', 'X1', 'btp', { data_prev_chegada: f(40), data_prev_saida: f(70), data_deadline: f(20) }),
  reg('MSC PERLE', 'UX641R', 'santos_brasil', { data_prev_chegada: f(-50), data_prev_saida: f(-5), data_deadline: f(-60) }, 'UX641R'),
  reg('LOGIN X', 'LX1', 'santos_brasil', { data_prev_chegada: f(-30), data_prev_saida: f(20) }, 'LX1'),
  reg('OUTRO', 'O1', 'santos_brasil', { data_prev_chegada: f(-40), data_prev_saida: f(25) }, 'O1'),
];

test('qualidade por terminal: previstas, reais devidas, armador e achados', () => {
  const norm = normalizarTodos(BRUTOS, AGORA);
  const mud = [{ em: new Date(AGORA - H).toISOString(), chave: 'btp|COPIAPO|MM643R', terminal: 'btp', campo: 'data_deadline' }, { em: new Date(AGORA - H).toISOString(), chave: 'btp|NOVO|X1', terminal: 'btp', campo: 'registro' }];
  const [btp, sb] = avaliarQualidade(BRUTOS, norm, mud, { agora: AGORA });
  assert.equal(btp.terminal, 'btp');
  assert.equal(btp.registros, 3);
  const real = (t, campo) => t.reais.find((x) => x.campo === campo);
  assert.deepEqual([real(btp, 'data_atracacao').preenchidos, real(btp, 'data_atracacao').total], [1, 2], 'NOVO ainda não deveria ter atracado');
  assert.deepEqual([real(btp, 'data_abertura_gate').preenchidos, real(btp, 'data_abertura_gate').total], [1, 2]);
  assert.equal(btp.previstas.find((x) => x.campo === 'data_prev_atracacao').pct, 0);
  assert.equal(btp.armador.pct, 100);
  assert.deepEqual(btp.mudancas, { dias: 7, datas: 1, navios: 1, porNavio: 1 }, '"registro" não conta como data mudada');

  assert.equal(sb.nome, 'Santos Brasil');
  assert.equal(real(sb, 'data_atracacao').pct, 0);
  assert.equal(sb.armador.corretos, 0);
  assert.equal(sb.achados[0].nivel, 'alto');
  assert.match(sb.achados[0].texto, /Atracação real nunca é informada \(0 de 3/);
  assert.ok(sb.achados.some((a) => /armador vazio ou igual à viagem/.test(a.texto)));
  assert.ok(sb.achados.some((a) => /saída prevista passou sem atracação/.test(a.texto)));
  assert.match(textoQualidade([btp, sb]), /^BTP \(3 registros\):\n- /);
});

test('rotas /api/navios.xlsx e /api/qualidade', async () => {
  const fetchDss = async () => new Response(JSON.stringify({ status: 200, apiVersion: 1, timezone: 'UTC', qtd_registros: BRUTOS.length, registros: BRUTOS }), { status: 200 });
  const srv = criarServidor(criarCliente({ url: 'https://dss.exemplo.com/x', fetch: fetchDss }), criarMemoria());
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const x = await fetch(`${base}/api/navios.xlsx?terminal=btp&encerrados=true`);
  assert.equal(x.status, 200);
  assert.equal(x.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(x.headers.get('content-disposition'), /attachment; filename="portal-de-navios-\d{4}-\d{2}-\d{2}\.xlsx"/);
  assert.equal(x.headers.get('content-encoding'), null, 'xlsx já é comprimido');
  const z = lerZip(Buffer.from(await x.arrayBuffer()));
  const s1 = z['xl/worksheets/sheet1.xml'];
  assert.equal((s1.match(/<row /g) || []).length, 4, 'cabeçalho + 3 navios da BTP');
  assert.match(s1, /MSC INSA/);
  assert.doesNotMatch(s1, /MSC PERLE/);

  const q = await (await fetch(`${base}/api/qualidade`)).json();
  assert.deepEqual(q.terminais.map((t) => t.terminal), ['btp', 'santos_brasil']);
  assert.match(q.texto, /Santos Brasil/);
  srv.close();
});
