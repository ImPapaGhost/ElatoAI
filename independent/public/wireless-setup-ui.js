import { getUsbSetupController } from './usb-setup.js';
import { pairDevice, listPairedDevices, forgetDevice, createWirelessSetup } from './wireless-setup.js';

const USB_HELP = 'Connect the Cardputer over USB. Open its setup screen, paste your key, and send it.';
const USB_PRIVACY = 'This page sends the key directly over USB; it does not upload the key to a web server.';
const WIFI_HELP = 'Use the same Wi-Fi as your paired Cardputer. Allow local network access if asked, and confirm a new key with Enter on the Cardputer.';
const WIFI_PRIVACY = 'Wireless commands are encrypted for your paired Cardputer on the local network. This page does not upload your key to a web server.';
const ERROR_TEXT = Object.freeze({
  unsupported: 'Use desktop Chrome or Edge to pair the Cardputer over USB.',
  unavailable: 'This browser cannot use secure wireless pairing. You can continue with USB.',
  storage: 'This browser could not save or read the pairing. You can continue with USB.',
  pairing: 'Pair this browser with your Cardputer over USB first.',
  metadata: 'Pairing details could not be verified. Pair again over USB.',
  address: 'The saved address is not a supported local Cardputer address. Pair again over USB.',
  network: 'Allow local network access and check that both devices use the same Wi-Fi, or use USB.',
  wrong_device: 'That address did not answer as your paired Cardputer. Pair again over USB.',
  authentication: 'The device reply could not be verified. Pair again over USB.',
  replay: 'The Cardputer returned a repeated challenge. Try again or use USB.',
  not_in_setup: 'Open setup on the Cardputer first, then send the key again.',
  confirmation_timeout: 'Confirmation timed out. Send again, then press Enter on the Cardputer.',
  device_cancelled: 'The Cardputer cancelled setup. Its previous settings were kept.',
  cancelled: 'Setup was cancelled.',
  api_key: 'Paste a valid key for the provider selected above.',
  reference: 'Enter the existing Agent ID or Config ID for this provider.',
  port_busy: 'Close the installer or serial monitor, then retry the USB pairing.',
  chooser_cancelled: 'Choose your Cardputer in the USB port prompt to pair it.',
  permission: 'USB permission was not granted. Use desktop Chrome or Edge and choose your Cardputer.',
  firmware: 'Update the Easy firmware and tap Reset on the Cardputer before pairing.',
  busy: 'Another setup request is running. Finish or cancel that request first.',
  device_busy: 'Finish or cancel the confirmation already shown on the Cardputer.',
  unknown_operation: 'The confirmation request is no longer available. Send the settings again.',
});

function status(node, message, kind = 'working') {
  node.textContent = message;
  node.dataset.state = kind;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
}

function safeMessage(error) {
  return Object.hasOwn(ERROR_TEXT, error?.code) ? ERROR_TEXT[error.code]
    : 'Wireless settings could not be completed. You can continue with USB.';
}

/** Reading saved pairing metadata on load never contacts a LAN device. */
export function bindWirelessSetupUi(document = globalThis.document, {
  storage, crypto = globalThis.crypto, fetchImpl,
  getUsbController = getUsbSetupController,
  pairDeviceImpl = pairDevice, listDevicesImpl = listPairedDevices,
  forgetDeviceImpl = forgetDevice, wirelessFactory = createWirelessSetup,
} = {}) {
  const get = (id) => document?.getElementById(id);
  const panel = get('wireless-settings');
  if (!panel || panel.dataset.wirelessBound === 'true') return null;
  const pair = get('wifi-pair');
  const devices = get('wifi-device');
  const enabled = get('wifi-enabled');
  const forget = get('wifi-forget');
  const wifiStatus = get('wifi-status');
  const form = get('usb-setup-form');
  const provider = get('usb-provider');
  const apiKey = get('usb-api-key');
  const reference = get('usb-reference');
  const open = get('usb-open-setup');
  const send = get('usb-send');
  const operationStatus = get('usb-status');
  const help = get('setup-connection-help');
  const privacy = get('setup-transport-privacy');
  if (![pair, devices, enabled, forget, wifiStatus, form, provider, apiKey, reference, open, send, operationStatus].every(Boolean)) return null;
  panel.dataset.wirelessBound = 'true';
  enabled.checked = false;
  let list = [];
  let busy = false;
  let current;
  const original = { send: send.textContent || 'Send to Cardputer', open: open.textContent || 'Open Cardputer setup',
    help: help?.textContent || USB_HELP, privacy: privacy?.textContent || USB_PRIVACY };

  function selected() { return list.find((device) => device.deviceId === devices.value); }

  function render() {
    const usb = getUsbController(document);
    const occupied = busy || usb?.busy === true;
    const available = Boolean(selected());
    if (!available) enabled.checked = false;
    enabled.disabled = occupied || !available;
    devices.disabled = occupied || list.length === 0;
    forget.disabled = occupied || !available;
    pair.disabled = occupied || !usb?.supported;
    provider.disabled = occupied;
    apiKey.disabled = occupied;
    reference.disabled = occupied || provider.value === 'gemini';
    const wifi = enabled.checked && available;
    send.disabled = occupied || (!wifi && !usb?.supported);
    open.disabled = send.disabled;
    if (wifi) {
      send.textContent = busy ? 'Waiting for Cardputer…' : 'Send over Wi-Fi';
      open.textContent = 'Open setup over Wi-Fi';
    } else {
      send.textContent = busy ? 'Waiting for Cardputer…' : original.send;
      open.textContent = original.open;
    }
    if (help) help.textContent = wifi ? WIFI_HELP : original.help;
    if (privacy) privacy.textContent = wifi ? WIFI_PRIVACY : original.privacy;
  }

  async function reload(selectId) {
    const prior = selectId || devices.value;
    list = await listDevicesImpl({ storage });
    devices.replaceChildren();
    for (const device of list) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = `${device.deviceId} — ${device.host}`;
      devices.append(option);
    }
    if (list.some((device) => device.deviceId === prior)) devices.value = prior;
    else if (list.length) devices.value = list[0].deviceId;
    render();
  }

  async function action(kind) {
    if (busy || getUsbController(document)?.busy === true) return;
    const device = selected();
    if (!device) { status(operationStatus, 'Pair this browser with your Cardputer over USB first.', 'error'); return; }
    busy = true;
    render();
    try {
      current = wirelessFactory({ device, storage, crypto, fetchImpl,
        onStatus: (update) => status(operationStatus, update.message, update.kind) });
      if (kind === 'open') await current.openSetup();
      else {
        const result = await current.send({ provider: provider.value, apiKey: apiKey.value, referenceId: reference.value });
        if (result?.type !== 'saved') throw new Error('Unverified save result.');
        apiKey.value = '';
      }
    } catch (error) {
      status(operationStatus, safeMessage(error), 'error');
    } finally {
      current = undefined;
      busy = false;
      render();
    }
  }

  // Capture handlers run before the existing USB submit/click handlers. USB is
  // unchanged when the explicit wireless checkbox is off (the default).
  form.addEventListener('submit', (event) => {
    if (!enabled.checked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!busy && (typeof form.reportValidity !== 'function' || form.reportValidity())) void action('send');
  }, { capture: true });
  open.addEventListener('click', (event) => {
    if (!enabled.checked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!busy) void action('open');
  }, { capture: true });

  pair.addEventListener('click', (event) => {
    event.preventDefault();
    if (busy) return;
    const usb = getUsbController(document);
    if (!usb?.supported || typeof usb.pairWireless !== 'function') {
      status(wifiStatus, 'Use desktop Chrome or Edge with the latest Easy firmware to pair over USB.', 'error');
      return;
    }
    busy = true;
    enabled.checked = false;
    render();
    status(wifiStatus, 'Choose the Cardputer USB port, then press Enter on the Cardputer to approve pairing. Open its setup screen first.');
    // Keep this call within the actual button gesture. No IndexedDB/network
    // await occurs before the browser asks the user to select a USB port.
    let pairing;
    try { pairing = usb.pairWireless(); }
    catch (error) { pairing = Promise.reject(error); }
    void (async () => {
      let metadata;
      try {
        metadata = await pairing;
        const saved = await pairDeviceImpl(metadata, { storage, crypto });
        await reload(saved.deviceId);
        status(wifiStatus, 'Pairing saved in this browser. Turn on wireless controls to use Wi-Fi.', 'success');
      } catch (error) {
        status(wifiStatus, safeMessage(error), 'error');
      } finally {
        if (metadata && typeof metadata === 'object') {
          metadata.controlSecret = '';
          delete metadata.controlSecret;
        }
        busy = false;
        render();
      }
    })();
  });

  forget.addEventListener('click', (event) => {
    event.preventDefault();
    if (busy || !selected()) return;
    const deviceId = selected().deviceId;
    busy = true;
    enabled.checked = false;
    render();
    void (async () => {
      try {
        await forgetDeviceImpl(deviceId, { storage });
        await reload();
        status(wifiStatus, 'Pairing forgotten in this browser. You can pair again over USB.', 'success');
      } catch (error) { status(wifiStatus, safeMessage(error), 'error'); }
      finally { busy = false; render(); }
    })();
  });

  enabled.addEventListener('change', render);
  devices.addEventListener('change', render);
  provider.addEventListener('change', render);
  form.addEventListener('cv-usb-state', render);
  document.defaultView?.addEventListener('pagehide', () => {
    apiKey.value = '';
    enabled.checked = false;
    current?.cancel?.();
  });
  render();
  const ready = reload().then(() => {
    status(wifiStatus, list.length ? 'A pairing is saved. Enable wireless controls when you want to use Wi-Fi.'
      : 'Pair once over USB to enable wireless settings in this browser.', 'idle');
  }).catch((error) => { status(wifiStatus, safeMessage(error), 'error'); render(); });
  return { ready, reload, cancel: () => current?.cancel?.(), get busy() { return busy; } };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bindWirelessSetupUi(), { once: true });
  else bindWirelessSetupUi();
}
