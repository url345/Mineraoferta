// GET /api/anuncios?q=...&country=BR&status=active            -> inicia a busca
// GET /api/anuncios?q=...&country=BR&status=active&runId=...  -> consulta o andamento / resultado
// Lê a Biblioteca de Anúncios pública da Meta por meio do Apify (serviço de terceiros, NÃO oficial da Meta).
// O token do Apify fica só aqui, em variável de ambiente.

const ATOR = process.env.APIFY_ACTOR || 'apify~facebook-ads-scraper';
const API = 'https://api.apify.com/v2';
const LIMITE_ANUNCIOS = Math.min(Number(process.env.RESULTS_LIMIT || 20), 100);
const LIMITE_POR_MIN = Number(process.env.LIMITE_POR_MINUTO || 10);
const LIMITE_DIARIO = Number(process.env.LIMITE_DIARIO || 50); // buscas novas por dia (controle de custo)
const CUSTO_MAX_USD = process.env.CUSTO_MAX_POR_BUSCA_USD || '1';

const cache = new Map();   // melhor esforço: cada instância serverless tem a sua
const acessos = new Map();
const dia = { d: '', n: 0 };

function origemPermitida(req) {
  const lista = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  return req.headers.origin && lista.includes(req.headers.origin) ? req.headers.origin : null;
}

function limitado(ip) {
  const t = Date.now();
  const l = (acessos.get(ip) || []).filter(x => t - x < 60000);
  l.push(t); acessos.set(ip, l);
  return l.length > LIMITE_POR_MIN;
}

function validar(q0) {
  const q = String(q0.q || '').replace(/\s+/g, ' ').trim();
  const country = String(q0.country || 'BR').toUpperCase();
  const status = String(q0.status || 'active').toLowerCase();
  const runId = String(q0.runId || '');
  if (q.length < 2 || q.length > 100) return { erro: 'Informe de 2 a 100 caracteres em q.' };
  if (!/^([A-Z]{2}|ALL)$/.test(country)) return { erro: 'País inválido.' };
  if (!['active', 'all'].includes(status)) return { erro: 'Status inválido.' };
  if (runId && !/^[A-Za-z0-9]{10,30}$/.test(runId)) return { erro: 'runId inválido.' };
  return { q, country, status, runId };
}

function urlBiblioteca(p) {
  return 'https://www.facebook.com/ads/library/?active_status=' + p.status +
    '&ad_type=all&country=' + p.country + '&media_type=all&search_type=keyword_unordered&q=' + encodeURIComponent(p.q);
}

const iso = v => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const d = new Date(isNaN(n) ? v : (n > 1e12 ? n : n * 1000));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const texto = v => (typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : '').trim();

// Converte um item do Apify para o formato que o site já entende (campos no estilo da API da Meta).
// Os nomes dos campos do ator podem mudar: confira um item real e ajuste aqui se preciso.
function mapear(x) {
  const s = x.snapshot || {};
  const id = String(x.adArchiveID || x.adArchiveId || x.ad_archive_id || x.adId || x.id || '').replace(/\D/g, '');
  if (!id) return null;
  let dominio = texto(s.caption);
  if (!dominio && s.link_url) { try { dominio = new URL(s.link_url).hostname; } catch (e) { /* ignora */ } }
  const plat = x.publisherPlatform || x.publisherPlatforms || x.publisher_platform || [];
  const corpo = texto(s.body) || texto(x.body) || texto(x.adText);
  const titulo = texto(s.title) || texto(x.title);
  return {
    id,
    page_id: String(x.pageID || x.pageId || x.page_id || ''),
    page_name: x.pageName || x.page_name || s.page_name || '',
    ad_creative_bodies: corpo ? [corpo] : [],
    ad_creative_link_titles: titulo ? [titulo] : [],
    ad_creative_link_captions: dominio ? [dominio] : [],
    ad_delivery_start_time: iso(x.startDate || x.start_date),
    ad_delivery_stop_time: iso(x.endDate || x.end_date),
    publisher_platforms: (Array.isArray(plat) ? plat : [plat]).filter(Boolean).map(z => String(z).toUpperCase()),
  };
}

async function apify(caminho, token, opcoes) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(API + caminho, {
      ...opcoes,
      signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('Apify', r.status, caminho.split('?')[0]); throw new Error('apify ' + r.status); }
    return j;
  } finally { clearTimeout(tm); }
}

module.exports = async (req, res) => {
  const origem = origemPermitida(req);
  if (origem) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não permitido.' });
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(500).json({ erro: 'Servidor sem credencial do Apify configurada.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  if (limitado(ip)) return res.status(429).json({ erro: 'Muitas consultas. Aguarde um minuto.' });

  const p = validar(req.query || {});
  if (p.erro) return res.status(400).json({ erro: p.erro });

  const chave = p.q.toLowerCase() + '|' + p.country + '|' + p.status;
  const pronto = cache.get(chave);
  if (pronto && Date.now() - pronto.t < 10 * 60 * 1000) return res.status(200).json(pronto.corpo);

  try {
    // 1) Sem runId: inicia uma busca nova
    if (!p.runId) {
      const hoje = new Date().toISOString().slice(0, 10);
      if (dia.d !== hoje) { dia.d = hoje; dia.n = 0; }
      if (++dia.n > LIMITE_DIARIO) return res.status(429).json({ erro: 'Limite diário de buscas atingido.' });
      const j = await apify(
        '/acts/' + ATOR + '/runs?timeout=150&maxTotalChargeUsd=' + encodeURIComponent(CUSTO_MAX_USD),
        token,
        { method: 'POST', body: JSON.stringify({ startUrls: [{ url: urlBiblioteca(p) }], resultsLimit: LIMITE_ANUNCIOS }) }
      );
      return res.status(200).json({ status: 'rodando', runId: j.data.id });
    }

    // 2) Com runId: verifica o andamento
    const run = (await apify('/actor-runs/' + p.runId, token, { method: 'GET' })).data;
    if (['READY', 'RUNNING'].includes(run.status)) return res.status(200).json({ status: 'rodando', runId: p.runId });
    if (run.status !== 'SUCCEEDED') return res.status(502).json({ erro: 'A coleta não foi concluída (' + run.status + ').' });

    const itens = await apify('/datasets/' + run.defaultDatasetId + '/items?clean=true&limit=' + LIMITE_ANUNCIOS, token, { method: 'GET' });
    const data = (Array.isArray(itens) ? itens : []).map(mapear).filter(Boolean);
    const corpo = {
      status: 'pronto',
      data,
      fonte: 'Biblioteca de Anúncios da Meta (leitura do site pelo Apify, não oficial)',
      atualizado_em: new Date().toISOString(),
      aviso: 'Idioma não é filtrado nesta fonte. Tempo de veiculação usa as datas publicadas.',
    };
    cache.set(chave, { t: Date.now(), corpo });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return res.status(200).json(corpo);
  } catch (e) {
    return res.status(e && e.name === 'AbortError' ? 504 : 502)
      .json({ erro: 'Falha ao consultar o serviço de coleta. Tente novamente.' });
  }
};
