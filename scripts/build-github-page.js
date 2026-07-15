#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

// Load .env file
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// 读取环境变量
const splitEnvList = (value) => value
  ? value.split(',').map(s => s.trim()).filter(Boolean)
  : [];

const normalizeCspOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw || /[\s;"']/.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return url.origin;
  } catch (_) {
    return '';
  }
};

const apiBase = splitEnvList(process.env.API_BASE);
const title = process.env.TITLE || '';
const backgroundImage = process.env.BACKGROUND_IMAGE || '';

// CSP 配置: 默认将 API_BASE 加入 csp_api 白名单
const cspApiFromEnv = apiBase.map(normalizeCspOrigin).filter(Boolean);
const cspApiExtra = splitEnvList(process.env.CSP_API).map(normalizeCspOrigin).filter(Boolean);
const cspStaticExtra = splitEnvList(process.env.CSP_STATIC).map(normalizeCspOrigin).filter(Boolean);

// API_BASE 需要同时支持 https 和 wss（WebSocket）
const apiDomainsWithWs = [];
for (const domain of [...new Set([...cspApiFromEnv, ...cspApiExtra])]) {
  apiDomainsWithWs.push(domain);
  if (domain.startsWith('https://')) {
    apiDomainsWithWs.push(domain.replace('https://', 'wss://'));
  }
}

const cspApiDomains = [...new Set(apiDomainsWithWs)];
const cspStaticDomains = [...new Set(cspStaticExtra)];

console.log('Config from env:', { apiBase, title, backgroundImage, cspApiDomains, cspStaticDomains });

console.log('Cleaning dist directory...');
if (fs.existsSync(distDir)) {
  fs.removeSync(distDir);
}

console.log('Building theme frontend...');
execSync('npx vite build', { cwd: rootDir, stdio: 'inherit', env: { ...process.env, VITE_BASE: './' } });

// 构建时注入配置到 HTML
const turnstileDomain = 'https://challenges.cloudflare.com';

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeCss(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const htmlFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.html'));
for (const file of htmlFiles) {
  const filePath = path.join(distDir, file);
  let html = fs.readFileSync(filePath, 'utf8');

  // 1. 注入 title
  if (title) {
    html = html.replace(/<title>.*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  }

  // 2. 注入运行时 meta 标签（仅当有 API_BASE 环境变量时）
  if (apiBase.length > 0) {
    html = html.replace(/<meta name="apiBase" content="[^"]*">/, `<meta name="apiBase" content="${escapeHtml(apiBase.join(','))}">`);
  }

  // 3. 注入 CSP meta 标签（仅当有 CSP 环境变量时，追加到默认白名单）
  if (cspStaticDomains.length > 0 || cspApiDomains.length > 0) {
    // 提取现有 CSP 中的域名
    const existingCspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)
    let existingDomains = []
    if (existingCspMatch) {
      const existingCsp = existingCspMatch[1]
      const domainRegex = /https?:\/\/[^\s';]+|wss?:\/\/[^\s';]+/g
      existingDomains = existingCsp.match(domainRegex) || []
    }
    // 按指令分类域名
    const insightsDomain = 'https://static.cloudflareinsights.com';
    const fontsApiDomain = 'https://fonts.googleapis.com';
    const fontsStaticDomain = 'https://fonts.gstatic.com';

    const scriptSrcDomains = [...new Set([
      ...existingDomains.filter(d => [turnstileDomain, insightsDomain].includes(d)),
      ...cspStaticDomains
    ])].join(' ');

    const styleSrcDomains = [...new Set([
      ...existingDomains.filter(d => [turnstileDomain, fontsApiDomain].includes(d)),
      ...cspStaticDomains
    ])].join(' ');

    const imgSrcDomains = [...new Set([
      ...existingDomains.filter(d => [turnstileDomain].includes(d)),
      ...cspStaticDomains
    ])].join(' ');

    const fontSrcDomains = [...new Set([
      ...existingDomains.filter(d => [turnstileDomain, fontsStaticDomain].includes(d)),
      ...cspStaticDomains
    ])].join(' ');

    const connectSrcDomains = [...new Set([
      ...existingDomains.filter(d => [turnstileDomain, insightsDomain].includes(d)),
      ...cspApiDomains
    ])].join(' ');

    const csp = [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline' ${scriptSrcDomains}`,
      `style-src 'self' 'unsafe-inline' ${styleSrcDomains}`,
      `img-src 'self' ${imgSrcDomains} data:`,
      `font-src 'self' ${fontSrcDomains}`,
      `connect-src 'self' ${connectSrcDomains}`,
      `frame-src ${turnstileDomain}`,
      `form-action 'self'`,
      `object-src 'none'`,
      `base-uri 'self'`
    ].join(';');
    html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }

  // 4. 注入背景图样式
  if (backgroundImage) {
    const bgStyle = `<style>body{background-image:url('${escapeCss(backgroundImage)}');background-size:cover;background-attachment:fixed;background-position:center;}</style>`;
    html = html.replace('</head>', `${bgStyle}\n</head>`);
  }

  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`Injected config into ${file}`);
}

console.log('Build complete!');
