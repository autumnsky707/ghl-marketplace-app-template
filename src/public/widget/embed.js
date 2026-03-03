/**
 * BookNexa Widget Embed Loader
 * Finds elements with data-booknexa-widget and creates iframes
 */
(function() {
  'use strict';

  var BASE = 'https://booknexaai-oauth.onrender.com';

  function init() {
    var els = document.querySelectorAll('[data-booknexa-widget]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var agentId = el.getAttribute('data-booknexa-widget');
      var theme = el.getAttribute('data-theme') || 'sage';
      var widget = el.getAttribute('data-widget') || 'concierge';
      var agent = el.getAttribute('data-agent') || 'sophia';
      var locationId = el.getAttribute('data-location-id') || '';
      var colors = el.getAttribute('data-colors') || '';

      if (!agentId) {
        console.error('[BookNexa] Missing data-booknexa-widget value');
        continue;
      }

      var src = BASE + '/widget/render?agentId=' + encodeURIComponent(agentId) +
        '&theme=' + encodeURIComponent(theme) +
        '&widget=' + encodeURIComponent(widget) +
        '&agent=' + encodeURIComponent(agent) +
        '&locationId=' + encodeURIComponent(locationId);
      if (colors) {
        src += '&colors=' + encodeURIComponent(colors);
      }

      var iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.style.cssText = 'border:none;width:100%;height:600px;';
      iframe.allow = 'microphone';
      iframe.title = 'BookNexa Widget';

      el.innerHTML = '';
      el.appendChild(iframe);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
