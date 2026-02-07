import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

/**
 * Render the status page HTML.
 *
 * Shows connection status banner, QR code area, and connection details.
 * Includes inline JavaScript WebSocket client that connects to /ws
 * for real-time updates (QR push, status changes).
 * WebSocket auto-reconnects on close with 2-second delay.
 */
export function renderStatusPage(): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>openWA - WhatsApp Bridge</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 640px;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    .status {
      padding: 1rem;
      border-radius: 8px;
      margin: 1rem 0;
      font-weight: 600;
      font-size: 1.1rem;
    }
    .connected { background: #d4edda; color: #155724; }
    .connecting { background: #cce5ff; color: #004085; }
    .disconnected { background: #f8d7da; color: #721c24; }
    .pairing { background: #fff3cd; color: #856404; }
    #qr {
      text-align: center;
      margin: 1.5rem 0;
    }
    #qr img {
      max-width: 300px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    #details {
      margin: 1rem 0;
    }
    #details p {
      padding: 0.3rem 0;
      color: #555;
    }
    #details strong {
      color: #1a1a1a;
    }
    .reconnect-info {
      font-size: 0.9rem;
      color: #666;
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <h1>openWA</h1>
  <div id="status" class="status pairing">Initializing...</div>
  <div id="qr"></div>
  <div id="details"></div>

  <script>
    (function() {
      var statusEl = document.getElementById('status');
      var qrEl = document.getElementById('qr');
      var detailsEl = document.getElementById('details');

      function connectWS() {
        var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var ws = new WebSocket(protocol + '//' + location.host + '/ws');

        ws.onmessage = function(event) {
          var msg = JSON.parse(event.data);

          if (msg.type === 'qr') {
            statusEl.className = 'status pairing';
            statusEl.textContent = 'Scan QR code with WhatsApp';
            qrEl.innerHTML = '<img src="' + msg.data + '" alt="QR Code">';
            detailsEl.innerHTML = '';
          } else if (msg.type === 'status') {
            var s = msg.data;
            statusEl.className = 'status ' + s.status;

            if (s.status === 'connected') {
              statusEl.textContent = 'Connected';
              qrEl.innerHTML = '';
              var info = '<p><strong>Account:</strong> ' +
                (s.account ? (s.account.name || s.account.phoneNumber) : 'Unknown') + '</p>';
              if (s.connectedAt) {
                info += '<p><strong>Connected since:</strong> ' + new Date(s.connectedAt).toLocaleString() + '</p>';
              }
              if (s.uptime > 0) {
                var h = Math.floor(s.uptime / 3600);
                var m = Math.floor((s.uptime % 3600) / 60);
                info += '<p><strong>Uptime:</strong> ' + h + 'h ' + m + 'm</p>';
              }
              detailsEl.innerHTML = info;
            } else if (s.status === 'connecting') {
              statusEl.textContent = 'Reconnecting... (attempt ' + s.reconnectAttempts + ')';
              qrEl.innerHTML = '';
              if (s.lastDisconnect) {
                detailsEl.innerHTML = '<p class="reconnect-info">Last disconnect: ' +
                  s.lastDisconnect.reason + ' (code ' + s.lastDisconnect.code + ')</p>';
              }
            } else if (s.status === 'disconnected') {
              statusEl.textContent = 'Disconnected';
              qrEl.innerHTML = '';
              if (s.lastDisconnect) {
                detailsEl.innerHTML = '<p><strong>Reason:</strong> ' +
                  s.lastDisconnect.reason + ' (code ' + s.lastDisconnect.code + ')</p>';
              }
            } else if (s.status === 'pairing') {
              statusEl.textContent = 'Waiting for QR code...';
              qrEl.innerHTML = '';
              detailsEl.innerHTML = '';
            }
          }
        };

        ws.onclose = function() {
          // Auto-reconnect WebSocket after 2 seconds
          setTimeout(connectWS, 2000);
        };

        ws.onerror = function() {
          ws.close();
        };
      }

      connectWS();
    })();
  </script>
</body>
</html>`;
}
