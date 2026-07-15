import { loadAppearanceOptions, DEFAULT_SITE_TITLE } from '../utils/settings.js';

let filesCache = null;

async function loadFrontendFiles(env) {
  if (filesCache) return filesCache;

  try {
    const files = {};
    
    // 尝试从 Cloudflare Pages/Asset 绑定读取
    if (env.ASSETS) {
      try {
        // 主要文件
        const mainFiles = ['dashboard.html', 'style.css'];
        for (const filename of mainFiles) {
          try {
            const res = await env.ASSETS.fetch(new Request(`http://static/${filename}`));
            if (res.ok) {
              files[filename] = await res.text();
            }
          } catch (e) {
            // 忽略错误
          }
        }
      } catch (e) {
        console.log('[INFO] No ASSETS binding');
      }
    }

    filesCache = files;
    return filesCache;
  } catch (e) {
    console.error('[ERROR] Failed to load frontend files:', e);
    return {};
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeCssString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function normalizeCspOrigin(value) {
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
}

function parseCspOrigins(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(normalizeCspOrigin)
    .filter(Boolean))];
}

function injectAppearanceSettings(html, settings) {
  let modifiedHtml = html;

  // 1. 更新页面标题
  const siteTitle = escapeHtml(settings.site_title || DEFAULT_SITE_TITLE);
  modifiedHtml = modifiedHtml.replace(/<title>.*<\/title>/, `<title>${siteTitle}</title>`);

  

  // 2. 追加 CSP 白名单域名
  const cspStatic = settings.csp_static || '';
  const cspApi = settings.csp_api || '';
  const staticDomains = parseCspOrigins(cspStatic);
  const rawApiDomains = parseCspOrigins(cspApi);

  // API 域名需要同时支持 https 和 wss（WebSocket）
  const apiDomains = [];
  for (const domain of rawApiDomains) {
    apiDomains.push(domain);
    if (domain.startsWith('https://')) {
      apiDomains.push(domain.replace('https://', 'wss://'));
    }
  }

  if (staticDomains.length > 0 || apiDomains.length > 0) {
    const turnstileDomain = 'https://challenges.cloudflare.com';
    const insightsDomain = 'https://static.cloudflareinsights.com';
    const fontsApiDomain = 'https://fonts.googleapis.com';
    const fontsStaticDomain = 'https://fonts.gstatic.com';

    // 从现有 CSP 中提取已有域名
    const cspMatch = modifiedHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    if (cspMatch) {
      const existingCsp = cspMatch[1];
      const domainRegex = /https?:\/\/[^\s';]+|wss?:\/\/[^\s';]+/g;
      const existingDomains = existingCsp.match(domainRegex) || [];

      // 按指令分类域名
      const scriptSrcDomains = [...new Set([
        ...existingDomains.filter(d => [turnstileDomain, insightsDomain].includes(d)),
        ...staticDomains
      ])].join(' ');

      const styleSrcDomains = [...new Set([
        ...existingDomains.filter(d => [turnstileDomain, fontsApiDomain].includes(d)),
        ...staticDomains
      ])].join(' ');

      const imgSrcDomains = [...new Set([
        ...existingDomains.filter(d => [turnstileDomain].includes(d)),
        ...staticDomains
      ])].join(' ');

      const fontSrcDomains = [...new Set([
        ...existingDomains.filter(d => [turnstileDomain, fontsStaticDomain].includes(d)),
        ...staticDomains
      ])].join(' ');

      const connectSrcDomains = [...new Set([
        ...existingDomains.filter(d => [turnstileDomain, insightsDomain].includes(d)),
        ...apiDomains
      ])].join(' ');

      // 构建新的 CSP
      const newCsp = [
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

      // 替换 CSP meta 标签（CSP 值不需要转义，它已经在双引号内）
      modifiedHtml = modifiedHtml.replace(
        cspMatch[0],
        `<meta http-equiv="Content-Security-Policy" content="${newCsp}">`
      );
    }
  }

  // 3. 注入 custom_head (在 </head> 标签前)
  if (settings.custom_head) {
    modifiedHtml = modifiedHtml.replace('</head>', `${settings.custom_head}\n</head>`);
  }

  // 4. 注入 custom_script (在 </body> 标签前)
  if (settings.custom_script) {
    modifiedHtml = modifiedHtml.replace('</body>', `<script>${settings.custom_script}</script>\n</body>`);
  }

  // 5. 注入 custom_bg (添加背景样式到 body)
  if (settings.custom_bg) {
    const safeBg = escapeCssString(settings.custom_bg);
    const bgStyle = `\n<style>\n  body { background-image: url('${safeBg}'); background-size: cover; background-attachment: fixed; background-position: center; }\n</style>\n`;
    modifiedHtml = modifiedHtml.replace('</head>', `${bgStyle}\n</head>`);
  }

  return modifiedHtml;
}

export async function serveFrontend(request, env, settings = null) {
  const url = new URL(request.url);
  const path = url.pathname;

  const files = await loadFrontendFiles(env);
  
  // Vue SPA - 所有路由都返回 dashboard.html
  let html = files['dashboard.html'];

  if (html) {
    if (!settings) {
      settings = await loadAppearanceOptions(env.DB);
    }
    html = injectAppearanceSettings(html, settings);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'CDN-Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }
    });
  }

  return new Response('Frontend not available. Please build the frontend first with `npm run build:frontend`.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}
