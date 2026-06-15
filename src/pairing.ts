/**
 * Phone pairing via QR code.
 *
 * Generates a QR code containing the bridge's npub and relay list.
 * The phone scans this QR to establish the encrypted channel.
 *
 * QR payload format:
 *   codedeck://pair?npub=<npub>&relays=<comma-separated>&machine=<hostname>
 */

import * as vscode from 'vscode';
import QRCode from 'qrcode-svg';
import type { PairingInfo, PairedPhone } from './types';

/**
 * Show a webview panel with the pairing QR code.
 * Uses a simple SVG-based QR code generator (no external dependencies).
 */
export function showPairingPanel(
  context: vscode.ExtensionContext,
  pairingInfo: PairingInfo,
  onPairPhone: (pubkeyHex: string, label: string) => void,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'codedeckPairing',
    'Codedeck: Pair Phone',
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const relaysParam = pairingInfo.relays.map(r => encodeURIComponent(r)).join(',');
  const tokenParam = pairingInfo.token ? `&token=${encodeURIComponent(pairingInfo.token)}` : '';
  const pairingUrl = `codedeck://pair?npub=${pairingInfo.npub}&relays=${relaysParam}&machine=${encodeURIComponent(pairingInfo.machine)}${tokenParam}`;

  panel.webview.html = getPairingHtml(pairingUrl, pairingInfo);

  // Handle manual pairing (user pastes npub)
  panel.webview.onDidReceiveMessage(
    message => {
      if (message.command === 'manualPair') {
        onPairPhone(message.pubkeyHex, message.label);
        panel.dispose();
        vscode.window.showInformationMessage(`Codedeck: Phone "${message.label}" paired successfully!`);
      }
    },
    undefined,
    context.subscriptions,
  );

  return panel;
}

function generateQrSvg(content: string): string {
  const qr = new QRCode({
    content,
    padding: 4,
    width: 256,
    height: 256,
    color: '#000000',
    background: '#ffffff',
    ecl: 'M',
    join: true,
    container: 'svg-viewbox',
  });
  return qr.svg();
}

function getPairingHtml(pairingUrl: string, info: PairingInfo): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    h1 { font-size: 1.4em; margin-bottom: 8px; }
    .info { opacity: 0.7; font-size: 0.9em; margin-bottom: 20px; text-align: center; }
    .qr-container {
      width: 256px;
      height: 256px;
      margin: 20px 0;
      border-radius: 8px;
      overflow: hidden;
    }
    .qr-container svg { width: 100%; height: 100%; }
    .url-box {
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-editorWidget-border);
      padding: 12px;
      border-radius: 4px;
      word-break: break-all;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      max-width: 500px;
      margin: 10px 0;
    }
    .section { margin-top: 24px; width: 100%; max-width: 500px; }
    .section h2 { font-size: 1.1em; }
    input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 6px 10px;
      width: 100%;
      box-sizing: border-box;
      margin: 4px 0;
      font-family: var(--vscode-editor-font-family);
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      margin-top: 8px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .npub { font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
    .success {
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      margin: 24px 0;
      padding: 24px;
      border-radius: 8px;
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.5);
      width: 100%;
      max-width: 500px;
      box-sizing: border-box;
    }
    .success .check { font-size: 2.4em; color: #22c55e; line-height: 1; }
    .success .title { font-size: 1.1em; font-weight: 600; }
    #pairContent.hidden { display: none; }
  </style>
</head>
<body>
  <h1>Pair Codedeck Phone</h1>

  <div id="successBox" class="success">
    <div class="check">✓</div>
    <div class="title" id="successTitle">Phone paired!</div>
    <p class="info">You can close this tab.</p>
  </div>

  <div id="pairContent">
    <p class="info">Scan this with your phone's camera, or copy the pairing URL below.</p>

    <div class="qr-container">
      ${generateQrSvg(pairingUrl)}
    </div>

    <p><strong>Pairing URL:</strong></p>
    <div class="url-box">${escapeHtml(pairingUrl)}</div>

    <p><strong>Bridge npub:</strong></p>
    <div class="url-box npub">${escapeHtml(info.npub)}</div>

    <p><strong>Machine:</strong> ${escapeHtml(info.machine)}</p>
    <p><strong>Relays:</strong> ${info.relays.map(escapeHtml).join(', ')}</p>

    <div class="section">
      <h2>Manual Pairing</h2>
      <p class="info" style="text-align: left;">
        Scanning should pair automatically. If it doesn't, paste the phone's npub below:
      </p>
      <input id="phoneNpub" placeholder="npub1..." />
      <input id="phoneLabel" placeholder="Phone label (e.g., My Pixel)" />
      <button onclick="manualPair()">Pair Phone</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // The extension posts { command: 'paired', label } when an auto-pair succeeds.
    window.addEventListener('message', (e) => {
      const data = e.data || {};
      if (data.command === 'paired') {
        const title = document.getElementById('successTitle');
        if (title) title.textContent = 'Phone "' + (data.label || 'Phone') + '" paired!';
        const box = document.getElementById('successBox');
        if (box) box.style.display = 'flex';
        const content = document.getElementById('pairContent');
        if (content) content.classList.add('hidden');
      }
    });

    function manualPair() {
      const npub = document.getElementById('phoneNpub').value.trim();
      const label = document.getElementById('phoneLabel').value.trim() || 'Phone';

      if (!npub.startsWith('npub1')) {
        alert('Invalid format. Enter an npub (npub1...) or paste from the Codedeck app settings.');
        return;
      }

      // Decode npub to hex (basic bech32 decode)
      // The extension will handle proper validation
      vscode.postMessage({
        command: 'manualPair',
        pubkeyHex: npub, // Extension will decode npub→hex
        label: label,
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Store/load paired phones from extension global state.
 */
export function loadPairedPhones(context: vscode.ExtensionContext): PairedPhone[] {
  return context.globalState.get<PairedPhone[]>('codedeck.pairedPhones', []);
}

export function savePairedPhones(context: vscode.ExtensionContext, phones: PairedPhone[]): Thenable<void> {
  return context.globalState.update('codedeck.pairedPhones', phones);
}

/**
 * Store/load the bridge's secret key from extension global state.
 */
export function loadSecretKey(context: vscode.ExtensionContext): Uint8Array | null {
  const hex = context.globalState.get<string>('codedeck.secretKeyHex');
  if (!hex) { return null; }
  return hexToBytes(hex);
}

export function saveSecretKey(context: vscode.ExtensionContext, sk: Uint8Array): Thenable<void> {
  return context.globalState.update('codedeck.secretKeyHex', bytesToHex(sk));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
