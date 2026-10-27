'use strict';

// Leitura de planilhas sem dependências externas. Devolve uma lista de linhas (cada linha é uma lista de células).
//   - .xlsx (zip com XML), descompactado com o zlib do próprio Node;
//   - .xls que na verdade é uma tabela HTML (formato comum em exportações de sistemas web);
//   - .csv / .txt (separador ; , ou tab).
// O .xls binário antigo (Excel 97-2003) não é suportado: a mensagem orienta a salvar como .xlsx ou CSV.

const zlib = require('node:zlib');
const { ErroApi } = require('../util');

// ---------------------------------------------------------------------------- utilidades
// Acentos em entidades HTML nomeadas (&ccedil; &atilde; &Eacute; …).
const ACENTOS = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧', ring: '̊' };
const OUTRAS = { ordm: 'º', ordf: 'ª', deg: '°', szlig: 'ß', ndash: '–', mdash: '—', euro: '€', middot: '·' };

function decodificarEntidades(texto) {
  return String(texto)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([A-Za-z])(acute|grave|circ|tilde|uml|cedil|ring);/g, (_, letra, tipo) => (letra + ACENTOS[tipo]).normalize('NFC'))
    .replace(/&(ordm|ordf|deg|szlig|ndash|mdash|euro|middot);/g, (_, nome) => OUTRAS[nome])
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Texto em UTF-8; se não for UTF-8 válido, lê como Windows-1252 (comum em exportações brasileiras). */
function comoTexto(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

// ---------------------------------------------------------------------------- zip (xlsx)
function lerZip(buffer) {
  // Fim do diretório central: assinatura 0x06054b50, procurada de trás para frente.
  let fim = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw new ErroApi('Arquivo .xlsx corrompido (zip sem diretório central).', { status: 400 });

  const total = buffer.readUInt16LE(fim + 10);
  let pos = buffer.readUInt32LE(fim + 16);
  const arquivos = new Map();
  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const metodo = buffer.readUInt16LE(pos + 10);
    const tamanhoCompactado = buffer.readUInt32LE(pos + 20);
    const tamNome = buffer.readUInt16LE(pos + 28);
    const tamExtra = buffer.readUInt16LE(pos + 30);
    const tamComentario = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const nome = buffer.toString('utf8', pos + 46, pos + 46 + tamNome);
    arquivos.set(nome, { metodo, tamanhoCompactado, local });
    pos += 46 + tamNome + tamExtra + tamComentario;
  }

  return (nome) => {
    const a = arquivos.get(nome);
    if (!a) return null;
    const inicio = a.local + 30 + buffer.readUInt16LE(a.local + 26) + buffer.readUInt16LE(a.local + 28);
    const dados = buffer.subarray(inicio, inicio + a.tamanhoCompactado);
    if (a.metodo === 0) return dados.toString('utf8');
    if (a.metodo === 8) return zlib.inflateRawSync(dados).toString('utf8');
    throw new ErroApi(`Compressão ${a.metodo} não suportada no .xlsx.`, { status: 400 });
  };
}

function indiceColuna(ref) {
  const letras = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  let n = 0;
  for (const l of letras) n = n * 26 + (l.charCodeAt(0) - 64);
  return n - 1;
}

function textoDosRuns(xml) {
  // <t>…</t> pode vir em vários "runs" (<r><t>…</t></r>) dentro do mesmo item.
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodificarEntidades(m[1])).join('');
}

function lerXlsx(buffer) {
  const abrir = lerZip(buffer);

  // Primeira aba do workbook.
  const workbook = abrir('xl/workbook.xml') || '';
  const rels = abrir('xl/_rels/workbook.xml.rels') || '';
  const primeiraAba = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  let caminho = 'xl/worksheets/sheet1.xml';
  if (primeiraAba) {
    const alvo = new RegExp(`<Relationship\\b[^>]*Id="${primeiraAba}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${primeiraAba}"`).exec(rels)?.[1];
    if (alvo) caminho = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo.replace(/^\.\//, '')}`;
  }
  const aba = abrir(caminho);
  if (!aba) throw new ErroApi('Não encontrei a primeira aba dentro do .xlsx.', { status: 400 });

  const compartilhadas = [...(abrir('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDosRuns(m[1]));

  const linhas = [];
  for (const mLinha of aba.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const linha = [];
    for (const mCel of mLinha[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const atributos = mCel[1];
      const conteudo = mCel[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(atributos)?.[1];
      const tipo = /\bt="([^"]+)"/.exec(atributos)?.[1] || 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(conteudo)?.[1];
      let valor = null;
      if (tipo === 's') valor = compartilhadas[Number(v)] ?? '';
      else if (tipo === 'inlineStr') valor = textoDosRuns(conteudo);
      else if (tipo === 'str' || tipo === 'e') valor = v === undefined ? '' : decodificarEntidades(v);
      else if (tipo === 'b') valor = v === '1';
      else valor = v === undefined || v === '' ? null : Number(v);
      linha[ref ? indiceColuna(ref) : linha.length] = valor;
    }
    linhas.push(Array.from(linha, (c) => (c === undefined ? null : c)));
  }
  return linhas;
}

// ---------------------------------------------------------------------------- HTML e CSV
function lerHtml(texto) {
  const tabelas = [...texto.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  // Usa a tabela com mais linhas (a página pode ter tabelas de layout).
  const tabela = tabelas.sort((a, b) => (b.match(/<tr\b/gi) || []).length - (a.match(/<tr\b/gi) || []).length)[0] || texto;
  return [...tabela.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((mLinha) =>
    [...mLinha[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((mCel) =>
      decodificarEntidades(mCel[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
    ),
  );
}

function lerCsv(texto) {
  const primeira = texto.split(/\r?\n/, 1)[0] || '';
  const separador = ['\t', ';', ','].sort((a, b) => primeira.split(b).length - primeira.split(a).length)[0];
  const linhas = [];
  let linha = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i += 1;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === separador) {
      linha.push(campo.trim());
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i += 1;
      linha.push(campo.trim());
      linhas.push(linha);
      linha = [];
      campo = '';
    } else campo += c;
  }
  if (campo || linha.length) {
    linha.push(campo.trim());
    linhas.push(linha);
  }
  return linhas.filter((l) => l.some((c) => c !== ''));
}

// ---------------------------------------------------------------------------- entrada
/** Lê o arquivo e devolve { formato, linhas }. */
function lerPlanilha(buffer) {
  if (!buffer || buffer.length === 0) throw new ErroApi('Arquivo vazio.', { status: 400 });
  if (buffer.readUInt32LE(0) === 0x04034b50) return { formato: 'xlsx', linhas: lerXlsx(buffer) };
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new ErroApi('Este é um .xls antigo (Excel 97-2003). Abra no Excel e salve como .xlsx ou CSV, depois importe de novo.', {
      status: 415,
    });
  }
  const texto = comoTexto(buffer);
  if (/<table\b/i.test(texto)) return { formato: 'html', linhas: lerHtml(texto) };
  return { formato: 'csv', linhas: lerCsv(texto) };
}

module.exports = { lerPlanilha, lerXlsx, lerHtml, lerCsv, decodificarEntidades };
