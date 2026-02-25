/**
 * BookNexa Widget Render Endpoint
 * Serves widget HTML at /widget/render
 * Query params: ?agentId=X&theme=sage&widget=concierge&agent=sophia
 */
import { Request, Response } from "express";
import axios from "axios";

const SETTINGS_PAGE_URL = 'https://booknexaai.com/spawidget-settings-page';

// Cache the settings page HTML (refresh every 10 minutes)
let cachedHTML: string | null = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchSettingsPage(): Promise<string> {
  const now = Date.now();
  if (cachedHTML && (now - cacheTime) < CACHE_TTL) {
    return cachedHTML;
  }

  try {
    const response = await axios.get(SETTINGS_PAGE_URL, {
      headers: {
        'Accept': 'text/html',
        'Accept-Encoding': 'gzip, deflate'
      },
      timeout: 30000
    });
    cachedHTML = response.data;
    cacheTime = now;
    return cachedHTML;
  } catch (error) {
    console.error('[Widget] Failed to fetch settings page:', error);
    throw error;
  }
}

function extractWidgetCode(html: string): { css: string; widgetHTML: string; js: string } {
  // Extract the custom code section which contains the widget
  const customCodeMatch = html.match(/<html lang="en">([\s\S]*?)<\/html>/);
  if (!customCodeMatch) {
    throw new Error('Could not find widget code in settings page');
  }

  const innerHTML = customCodeMatch[1];

  // Extract CSS (everything between <style> and </style>)
  const cssMatch = innerHTML.match(/<style>([\s\S]*?)<\/style>/);
  const css = cssMatch ? cssMatch[1] : '';

  // Extract widget HTML (preview area)
  const previewMatch = innerHTML.match(/<div id="previewArea"[\s\S]*?(?=<script type="module">)/);
  const widgetHTML = previewMatch ? previewMatch[0] : '';

  // Extract JavaScript
  const jsMatch = innerHTML.match(/<script type="module">([\s\S]*?)<\/script>/);
  const js = jsMatch ? jsMatch[1] : '';

  return { css, widgetHTML, js };
}

export async function widgetRenderHandler(req: Request, res: Response): Promise<void> {
  const { agentId, theme = 'sage', widget = 'concierge', agent = 'sophia' } = req.query;

  if (!agentId) {
    res.status(400).send('Missing agentId parameter');
    return;
  }

  try {
    const settingsHTML = await fetchSettingsPage();
    const { css, widgetHTML, js } = extractWidgetCode(settingsHTML);

    // Determine which widget to show based on query param
    const widgetType = (widget as string).toLowerCase();
    let showWidget = 'concierge';
    if (widgetType === 'banner') showWidget = 'banner';
    else if (widgetType === 'classic') showWidget = 'classic';

    // Determine theme class
    const themeClass = `theme-${(theme as string).toLowerCase().replace('-', '')}`;

    // Determine agent name
    const agentName = (agent as string).charAt(0).toUpperCase() + (agent as string).slice(1).toLowerCase();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>BookNexa AI Widget</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500;600&family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400;1,500&display=swap" rel="stylesheet">
  <style>
    /* Hide settings UI - only show widget */
    .app-header, .control-bar, .settings-wrapper, .settings-dropdown { display: none !important; }
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    .preview-area {
      min-height: 100vh !important;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px;
    }
    /* Show only the selected widget */
    .widget { display: none !important; }
    .widget.active { display: block !important; }
    ${css}
  </style>
</head>
<body>
  <div id="previewArea" class="preview-area ${themeClass}">
    ${widgetHTML}
  </div>
  <script>
    // Set agent name in all elements
    document.querySelectorAll('.agent-name').forEach(el => el.textContent = '${agentName}');

    // Show only the selected widget
    document.querySelectorAll('.widget').forEach(w => w.classList.remove('active'));
    const selectedWidget = document.getElementById('widget${showWidget.charAt(0).toUpperCase() + showWidget.slice(1)}');
    if (selectedWidget) selectedWidget.classList.add('active');

    // Apply theme
    const previewArea = document.getElementById('previewArea');
    previewArea.className = 'preview-area ${themeClass}';
  </script>
  <script type="module">
    ${js}
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(html);
  } catch (error) {
    console.error('[Widget] Error rendering widget:', error);
    res.status(500).send('Error loading widget');
  }
}
