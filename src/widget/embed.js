/**
 * BookNexa AI Widget Embed Loader
 * Creates iframe pointing to /widget/render
 *
 * Usage:
 * <div data-booknexa-widget="AGENT_ID" data-theme="sage-zen" data-widget="card"></div>
 * <script src="https://booknexaai-oauth.onrender.com/widget/embed.js" async></script>
 */
(function() {
  'use strict';

  const WIDGET_BASE = 'https://booknexaai-oauth.onrender.com';

  function initWidget(container) {
    const agentId = container.dataset.booknexaWidget;
    const theme = container.dataset.theme || 'sage-zen';
    const widgetType = container.dataset.widget || 'card';
    const agentName = container.dataset.agent || '';

    if (!agentId) {
      console.error('[BookNexa] Missing data-booknexa-widget attribute');
      return;
    }

    // Build iframe URL with query params
    const params = new URLSearchParams({
      agentId: agentId,
      theme: theme,
      widget: widgetType
    });
    if (agentName) params.set('agent', agentName);

    const iframeSrc = `${WIDGET_BASE}/widget/render?${params.toString()}`;

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.src = iframeSrc;
    iframe.title = 'BookNexa AI Widget';
    iframe.allow = 'microphone';
    iframe.style.cssText = 'border:none;width:100%;height:100%;min-height:500px;';

    // Clear container and add iframe
    container.innerHTML = '';
    container.appendChild(iframe);
  }

  function init() {
    const widgets = document.querySelectorAll('[data-booknexa-widget]');
    widgets.forEach(initWidget);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
