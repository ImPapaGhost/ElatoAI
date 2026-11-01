"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const state = { config: null, dashboard: null, token: null, tokenDeviceId: null };
  const elements = {
    appName: byId("app-name"),
    loading: byId("loading-panel"),
    setup: byId("setup-panel"),
    setupDescription: byId("setup-description"),
    missing: byId("missing-settings"),
    checkSetup: byId("check-setup-button"),
    login: byId("login-panel"),
    loginForm: byId("login-form"),
    loginFields: byId("login-fields"),
    loginButton: byId("login-button"),
    password: byId("password"),
    logout: byId("logout-button"),
    dashboard: byId("dashboard"),
    feedback: byId("feedback"),
    settingsForm: byId("settings-form"),
    settingsFields: byId("settings-fields"),
    saveSettings: byId("save-settings-button"),
    characterName: byId("character-name"),
    prompt: byId("system-prompt"),
    voice: byId("voice-name"),
    volume: byId("volume"),
    volumeValue: byId("volume-value"),
    sessionLimit: byId("session-limit"),
    quotaUsed: byId("quota-used"),
    quotaRemaining: byId("quota-remaining"),
    quotaProgress: byId("quota-progress"),
    deviceList: byId("device-list"),
    deviceEmpty: byId("device-empty"),
    deviceForm: byId("device-form"),
    deviceFields: byId("device-fields"),
    deviceName: byId("device-name"),
    deviceMac: byId("device-mac"),
    deviceAddNote: byId("device-add-note"),
    addDevice: byId("add-device-button"),
    secret: byId("device-secret"),
    token: byId("device-token"),
    copyToken: byId("copy-token-button"),
    dismissToken: byId("dismiss-token-button"),
    messages: byId("messages"),
    messagesEmpty: byId("messages-empty"),
    refresh: byId("refresh-button"),
  };

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
    });
    let data = null;
    if (response.headers.get("content-type")?.includes("application/json")) {
      data = await response.json();
    }
    if (!response.ok) {
      const detail = typeof data?.error === "string" ? data.error : null;
      throw new ApiError(detail || "The request could not be completed. Please try again.", response.status);
    }
    return data;
  }

  function feedback(message, type = "success") {
    elements.feedback.textContent = message;
    elements.feedback.className = `feedback feedback-${type}`;
    elements.feedback.hidden = false;
  }

  function clearFeedback() {
    elements.feedback.textContent = "";
    elements.feedback.hidden = true;
  }

  function clearToken() {
    state.token = null;
    state.tokenDeviceId = null;
    elements.token.textContent = "";
    elements.secret.hidden = true;
    elements.copyToken.textContent = "Copy token";
  }

  function showLogin() {
    state.dashboard = null;
    clearToken();
    elements.dashboard.hidden = true;
    elements.logout.hidden = true;
    elements.login.hidden = false;
    elements.loginFields.disabled = !state.config?.configured;
    elements.messages.replaceChildren();
    elements.deviceList.replaceChildren();
    elements.characterName.value = "";
    elements.prompt.value = "";
    elements.password.value = "";
  }

  function handleError(error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin();
      feedback("Please sign in to continue.", "error");
      return;
    }
    feedback(error instanceof ApiError ? error.message : "Could not reach the service. Check your connection and try again.", "error");
  }

  function voiceOptions() {
    return (Array.isArray(state.config?.voices) ? state.config.voices : []).flatMap((voice) => {
      const name = typeof voice === "string" ? voice : voice?.name;
      if (typeof name !== "string" || !name) return [];
      return [{ name, label: typeof voice?.label === "string" ? voice.label : name }];
    });
  }

  function renderVoices(selected) {
    const options = voiceOptions();
    elements.voice.replaceChildren();
    for (const voice of options) {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = voice.label;
      elements.voice.append(option);
    }
    if (options.some((voice) => voice.name === selected)) elements.voice.value = selected;
    if (!options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No voices configured";
      elements.voice.append(option);
    }
    elements.saveSettings.disabled = options.length === 0;
  }

  function minutes(seconds) {
    const value = Math.max(0, Number(seconds) || 0) / 60;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
  }

  function renderQuota(usage) {
    const used = Math.max(0, Number(usage?.used_seconds) || 0);
    const limit = Math.max(0, Number(usage?.limit_seconds) || 0);
    elements.quotaUsed.textContent = `${minutes(used)} used of ${minutes(limit)}`;
    elements.quotaRemaining.textContent = minutes(Math.max(0, limit - used));
    elements.quotaProgress.max = Math.max(1, limit);
    elements.quotaProgress.value = Math.min(used, elements.quotaProgress.max);
    elements.quotaProgress.setAttribute("aria-valuetext", `${minutes(used)} used of ${minutes(limit)}`);
    elements.quotaProgress.classList.toggle("at-limit", used >= limit);
    const sessionSeconds = Number(state.config?.sessionSeconds);
    elements.sessionLimit.hidden = !(sessionSeconds > 0);
    elements.sessionLimit.textContent = `Up to ${minutes(sessionSeconds)} per voice session`;
  }

  function renderDevices(devices) {
    const list = Array.isArray(devices) ? devices : [];
    elements.deviceList.replaceChildren();
    elements.deviceEmpty.hidden = list.length > 0;
    const hasEnabledDevice = list.some((device) => device.enabled === true);
    elements.deviceFields.disabled = hasEnabledDevice;
    elements.deviceAddNote.textContent = hasEnabledDevice
      ? "Disable the current device before adding another."
      : "Use your Cardputer's Wi-Fi MAC address.";

    for (const device of list) {
      const item = document.createElement("li");
      item.className = "device-item";
      const heading = document.createElement("div");
      heading.className = "device-item-heading";
      const name = document.createElement("strong");
      name.textContent = typeof device.name === "string" ? device.name : "Cardputer";
      const badge = document.createElement("span");
      badge.className = `device-badge ${device.enabled ? "device-enabled" : "device-disabled"}`;
      badge.textContent = device.enabled ? "Access enabled" : "Disabled";
      heading.append(name, badge);
      const mac = document.createElement("code");
      mac.className = "device-mac";
      mac.textContent = typeof device.mac === "string" ? device.mac : "";
      item.append(heading, mac);
      if (device.enabled === true && device.id != null) {
        const disable = document.createElement("button");
        disable.className = "button button-danger";
        disable.type = "button";
        disable.textContent = "Disable device";
        disable.addEventListener("click", async () => {
          disable.disabled = true;
          clearFeedback();
          try {
            await api(`/api/devices/${encodeURIComponent(String(device.id))}`, { method: "DELETE" });
            if (String(state.tokenDeviceId) === String(device.id)) clearToken();
            await loadDashboard();
            feedback("Device access disabled.");
          } catch (error) {
            handleError(error);
          } finally {
            disable.disabled = false;
          }
        });
        item.append(disable);
      }
      elements.deviceList.append(item);
    }
  }

  function renderMessages(messages, characterName) {
    const list = Array.isArray(messages) ? [...messages] : [];
    list.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
    elements.messages.replaceChildren();
    elements.messagesEmpty.hidden = list.length > 0;
    for (const message of list) {
      const item = document.createElement("li");
      item.className = message.role === "user" ? "message message-user" : "message message-assistant";
      const meta = document.createElement("div");
      meta.className = "message-meta";
      const author = document.createElement("strong");
      author.textContent = message.role === "user" ? "You" : message.role === "assistant" ? characterName || "Assistant" : "Service";
      meta.append(author);
      const date = new Date(message.created_at);
      if (Number.isFinite(date.getTime())) {
        const time = document.createElement("time");
        time.dateTime = date.toISOString();
        time.textContent = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        meta.append(time);
      }
      const content = document.createElement("p");
      content.textContent = typeof message.content === "string" ? message.content : "";
      item.append(meta, content);
      elements.messages.append(item);
    }
  }

  async function loadDashboard() {
    const data = await api("/api/dashboard");
    if (!data || typeof data.settings !== "object" || data.settings === null) {
      throw new Error("Invalid dashboard response");
    }
    state.dashboard = data;
    const settings = data.settings;
    elements.characterName.value = typeof settings.character_name === "string" ? settings.character_name : "";
    elements.prompt.value = typeof settings.system_prompt === "string" ? settings.system_prompt : "";
    renderVoices(settings.voice_name);
    elements.volume.value = String(Math.max(0, Math.min(100, Number(settings.volume) || 0)));
    elements.volumeValue.value = `${elements.volume.value}%`;
    renderQuota(data.usage);
    renderDevices(data.devices);
    renderMessages(data.messages, settings.character_name);
    elements.login.hidden = true;
    elements.setup.hidden = true;
    elements.dashboard.hidden = false;
    elements.logout.hidden = false;
  }

  async function bootstrap() {
    elements.loading.hidden = false;
    elements.checkSetup.disabled = true;
    clearFeedback();
    try {
      const config = await api("/api/config");
      if (!config || typeof config !== "object") throw new Error("Invalid configuration response");
      state.config = config;
      const appName = typeof config.appName === "string" && config.appName.trim() ? config.appName : "Cardputer Voice";
      elements.appName.textContent = appName;
      document.title = appName;
      elements.missing.replaceChildren();
      for (const setting of Array.isArray(config.missing) ? config.missing : []) {
        const item = document.createElement("li");
        const name = document.createElement("code");
        name.textContent = String(setting);
        item.append(name);
        elements.missing.append(item);
      }
      elements.setupDescription.textContent = "Finish configuring the private service before signing in. Missing settings:";
      elements.setup.hidden = config.configured === true;
      if (config.configured === true) {
        try {
          await loadDashboard();
        } catch (error) {
          showLogin();
          if (!(error instanceof ApiError && error.status === 401)) handleError(error);
        }
      } else {
        showLogin();
      }
    } catch (error) {
      state.config = null;
      showLogin();
      elements.setup.hidden = false;
      elements.missing.replaceChildren();
      elements.setupDescription.textContent = "The service configuration could not be loaded. Check your connection, then try again.";
      handleError(error);
    } finally {
      elements.loading.hidden = true;
      elements.checkSetup.disabled = false;
    }
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.config?.configured) return;
    const values = new FormData(elements.loginForm);
    elements.loginFields.disabled = true;
    elements.loginButton.textContent = "Signing in…";
    clearFeedback();
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: String(values.get("email") || "").trim(), password: String(values.get("password") || "") }),
      });
      elements.password.value = "";
      await loadDashboard();
      feedback("You're signed in.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        elements.password.value = "";
        feedback("Sign-in failed. Check your owner email and password.", "error");
      } else {
        handleError(error);
      }
    } finally {
      elements.loginFields.disabled = !state.config?.configured;
      elements.loginButton.textContent = "Sign in";
    }
  });

  elements.logout.addEventListener("click", async () => {
    clearToken();
    elements.logout.disabled = true;
    clearFeedback();
    try {
      await api("/api/logout", { method: "POST" });
      showLogin();
      feedback("You're signed out.");
    } catch (error) {
      handleError(error);
    } finally {
      elements.logout.disabled = false;
    }
  });

  elements.volume.addEventListener("input", () => {
    elements.volumeValue.value = `${elements.volume.value}%`;
  });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(elements.settingsForm);
    const voiceName = String(values.get("voice_name") || "");
    if (!voiceOptions().some((voice) => voice.name === voiceName)) {
      feedback("Choose an available voice before saving.", "error");
      return;
    }
    const settings = {
      character_name: String(values.get("character_name") || "").trim(),
      system_prompt: String(values.get("system_prompt") || "").trim(),
      voice_name: voiceName,
      volume: Number(values.get("volume")),
    };
    if (!settings.character_name || !settings.system_prompt) {
      feedback("Add a character name and instructions before saving.", "error");
      return;
    }
    elements.settingsFields.disabled = true;
    elements.saveSettings.textContent = "Saving…";
    clearFeedback();
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      await loadDashboard();
      feedback("Character saved. Your next voice session will use these settings.");
    } catch (error) {
      handleError(error);
    } finally {
      elements.settingsFields.disabled = false;
      elements.saveSettings.textContent = "Save character";
    }
  });

  elements.deviceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (elements.deviceFields.disabled) return;
    const values = new FormData(elements.deviceForm);
    const name = String(values.get("name") || "").trim();
    const mac = String(values.get("mac") || "").trim().replace(/-/g, ":").toUpperCase();
    if (!name || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
      feedback("Enter a device name and a MAC address such as AA:BB:CC:DD:EE:FF.", "error");
      return;
    }
    elements.deviceFields.disabled = true;
    elements.addDevice.textContent = "Adding…";
    clearFeedback();
    try {
      const data = await api("/api/devices", { method: "POST", body: JSON.stringify({ name, mac }) });
      if (typeof data?.token !== "string" || !data.token) throw new Error("Device token not returned");
      state.token = data.token;
      state.tokenDeviceId = data.device?.id ?? null;
      elements.token.textContent = data.token;
      elements.secret.hidden = false;
      elements.copyToken.textContent = "Copy token";
      elements.deviceForm.reset();
      await loadDashboard();
      feedback("Cardputer added. Save the device token shown in the device panel.");
      elements.copyToken.focus();
    } catch (error) {
      handleError(error);
    } finally {
      const devices = state.dashboard?.devices;
      elements.deviceFields.disabled = Array.isArray(devices) && devices.some((device) => device.enabled === true);
      elements.addDevice.textContent = "Add Cardputer";
    }
  });

  elements.copyToken.addEventListener("click", async () => {
    if (!state.token) return;
    if (!navigator.clipboard?.writeText) {
      feedback("Clipboard access is unavailable. Select and copy the device token above.", "error");
      elements.token.focus();
      return;
    }
    try {
      await navigator.clipboard.writeText(state.token);
      elements.copyToken.textContent = "Copied";
      feedback("Device token copied. Keep it private.");
    } catch {
      feedback("The token could not be copied. Select and copy it from the device panel.", "error");
    }
  });

  elements.dismissToken.addEventListener("click", () => {
    clearToken();
    feedback("Token hidden. Disable the device and add it again if you need a new token.");
  });

  elements.refresh.addEventListener("click", async () => {
    elements.refresh.disabled = true;
    elements.refresh.textContent = "Refreshing…";
    clearFeedback();
    try {
      await loadDashboard();
      feedback("Workspace refreshed.");
    } catch (error) {
      handleError(error);
    } finally {
      elements.refresh.disabled = false;
      elements.refresh.textContent = "Refresh";
    }
  });

  elements.checkSetup.addEventListener("click", bootstrap);
  window.addEventListener("pagehide", clearToken);
  bootstrap();
})();
